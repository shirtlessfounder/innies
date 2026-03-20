import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';
import { stableUuid } from '../src/utils/hash.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type AdminRouteModule = typeof import('../src/routes/admin.js');

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
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string>;
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

function getRouteHandlers(router: any, routePath: string, method: 'get' | 'post'): Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
}

describe('admin pilot routes', () => {
  let runtimeModule: RuntimeModule;
  let sessionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let cutoverHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rollbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let requestHistoryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let requestExplanationHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let unfinalizedRequestHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletLedgerHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletAdjustmentHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletProjectorHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletProjectorRetryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rateCardListHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let rateCardCreateHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let meteringCorrectionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/admin.js') as AdminRouteModule;
    sessionHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/session', 'post');
    cutoverHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/cutover', 'post');
    rollbackHandlers = getRouteHandlers(mod.default as any, '/v1/admin/pilot/rollback', 'post');
    requestHistoryHandlers = getRouteHandlers(mod.default as any, '/v1/admin/requests', 'get');
    requestExplanationHandlers = getRouteHandlers(mod.default as any, '/v1/admin/requests/:requestId/explanation', 'get');
    unfinalizedRequestHandlers = getRouteHandlers(mod.default as any, '/v1/admin/requests/unfinalized', 'get');
    walletHandlers = getRouteHandlers(mod.default as any, '/v1/admin/wallets/:walletId', 'get');
    walletLedgerHandlers = getRouteHandlers(mod.default as any, '/v1/admin/wallets/:walletId/ledger', 'get');
    walletAdjustmentHandlers = getRouteHandlers(mod.default as any, '/v1/admin/wallets/:walletId/adjustments', 'post');
    walletProjectorHandlers = getRouteHandlers(mod.default as any, '/v1/admin/metering/projectors/wallet', 'get');
    walletProjectorRetryHandlers = getRouteHandlers(mod.default as any, '/v1/admin/metering/projectors/wallet/:meteringEventId/retry', 'post');
    rateCardListHandlers = getRouteHandlers(mod.default as any, '/v1/admin/rate-cards', 'get');
    rateCardCreateHandlers = getRouteHandlers(mod.default as any, '/v1/admin/rate-cards', 'post');
    meteringCorrectionHandlers = getRouteHandlers(mod.default as any, '/v1/admin/metering/corrections', 'post');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'findActiveByHash').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: 'org_innies',
      scope: 'admin',
      is_active: true,
      expires_at: null,
      preferred_provider: null,
      is_frozen: false
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.apiKeys, 'touchLastUsed').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listAdminRequestHistory').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'getRequestExplanation').mockResolvedValue(null);
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listFinanciallyUnfinalizedRequests').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'getWalletSnapshot').mockResolvedValue({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      balanceMinor: 0,
      currency: 'USD'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'listWalletLedger').mockResolvedValue({
      entries: [],
      nextCursor: null
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'recordManualAdjustment').mockResolvedValue({
      id: 'wallet_entry_manual'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'listWalletProjectionBacklog').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'retryWalletProjection').mockResolvedValue({
      metering_event_id: 'meter_1',
      projector: 'wallet',
      state: 'pending_projection'
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.rateCards, 'listVersions').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.repos.rateCards, 'createVersionWithLineItems').mockResolvedValue({
      version: {
        id: 'rate_1',
        version_key: 'pilot-v1',
        effective_at: '2026-03-20T00:00:00Z',
        created_at: '2026-03-20T00:00:00Z'
      },
      lineItems: [{
        id: 'line_1',
        rate_card_version_id: 'rate_1',
        provider: 'anthropic',
        model_pattern: '*',
        routing_mode: 'paid-team-capacity',
        buyer_debit_minor_per_unit: 3,
        contributor_earnings_minor_per_unit: 0,
        currency: 'USD',
        created_at: '2026-03-20T00:00:00Z'
      }]
    } as any);
    vi.spyOn(runtimeModule.runtime.repos.auditLogs, 'createEvent').mockResolvedValue({ id: 'audit_1' } as any);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: false
    } as any);
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    vi.spyOn(runtimeModule.runtime.services.metering, 'recordUsage').mockResolvedValue({
      id: 'usage_1',
      entry_type: 'usage'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints an admin impersonation session token', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'issueSession').mockReturnValue('admin-session-token');

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/session',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        mode: 'impersonation',
        targetUserId: 'user_darryn',
        targetOrgId: 'org_fnf',
        targetOrgSlug: 'fnf',
        targetOrgName: 'Friends & Family',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    });
    const res = createMockRes();

    await invoke(sessionHandlers[0], req, res);
    await invoke(sessionHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      sessionToken: 'admin-session-token',
      session: expect.objectContaining({
        sessionKind: 'admin_impersonation',
        effectiveOrgId: 'org_fnf',
        impersonatedUserId: 'user_darryn'
      })
    }));
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=admin-session-token');
  });

  it('starts a cutover through the cutover service', async () => {
    const cutover = vi.spyOn(runtimeModule.runtime.services.pilotCutovers, 'cutover').mockResolvedValue({
      targetOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverRecord: { id: 'cut_1', effective_at: '2026-03-20T00:00:00Z' }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/cutover',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        sourceOrgId: 'org_innies',
        targetOrgSlug: 'fnf',
        targetOrgName: 'Friends & Family',
        targetUserEmail: 'darryn@example.com',
        targetUserDisplayName: 'Darryn',
        buyerKeyIds: ['buyer_1'],
        tokenCredentialIds: ['cred_1']
      }
    });
    const res = createMockRes();

    await invoke(cutoverHandlers[0], req, res);
    await invoke(cutoverHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      cutoverId: 'cut_1',
      targetOrgId: 'org_fnf',
      targetUserId: 'user_darryn'
    }));
    expect(cutover).toHaveBeenCalledWith({
      sourceOrgId: 'org_innies',
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      targetUserEmail: 'darryn@example.com',
      targetUserDisplayName: 'Darryn',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1'],
      actorUserId: null,
      effectiveAt: undefined
    });
  });

  it('starts a rollback through the cutover service', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotCutovers, 'rollback').mockResolvedValue({
      rollbackRecord: { id: 'rollback_1', effective_at: '2026-03-20T01:00:00Z' }
    } as any);

    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/pilot/rollback',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json'
      },
      body: {
        sourceCutoverId: 'cut_1',
        targetOrgId: 'org_innies',
        buyerKeyIds: ['buyer_1'],
        tokenCredentialIds: ['cred_1']
      }
    });
    const res = createMockRes();

    await invoke(rollbackHandlers[0], req, res);
    await invoke(rollbackHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      rollbackId: 'rollback_1'
    }));
  });

  it('returns admin request history with a pagination cursor', async () => {
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listAdminRequestHistory').mockResolvedValue([{
      request_id: 'req_1',
      attempt_no: 1,
      session_id: 'sess_1',
      admission_org_id: 'org_fnf',
      admission_cutover_id: 'cut_1',
      admission_routing_mode: 'paid-team-capacity',
      consumer_org_id: 'org_fnf',
      buyer_key_id: 'buyer_1',
      serving_org_id: 'org_innies',
      provider_account_id: 'acct_1',
      token_credential_id: null,
      capacity_owner_user_id: null,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      rate_card_version_id: 'rate_1',
      input_tokens: 10,
      output_tokens: 20,
      usage_units: 30,
      buyer_debit_minor: 90,
      contributor_earnings_minor: 0,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T10:00:00.000Z',
      prompt_preview: 'hello',
      response_preview: 'world',
      route_decision: { reason: 'preferred_provider_selected' },
      projector_states: []
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/requests',
      headers: {
        authorization: 'Bearer in_admin_token'
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);
    await invoke(requestHistoryHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      requests: [expect.objectContaining({ request_id: 'req_1' })],
      nextCursor: null
    }));
    expect(runtimeModule.runtime.repos.routingAttribution.listAdminRequestHistory).toHaveBeenCalledWith({
      consumerOrgId: undefined,
      limit: 20,
      cursor: null,
      historyScope: 'all'
    });
  });

  it('accepts and emits full admin request-history cursors', async () => {
    const decodedCursor = {
      createdAt: '2026-03-19T09:00:00.000Z',
      requestId: 'req_8',
      attemptNo: 2
    };
    const encodedCursor = Buffer.from(JSON.stringify(decodedCursor), 'utf8').toString('base64url');
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listAdminRequestHistory').mockResolvedValue([{
      request_id: 'req_9',
      attempt_no: 3,
      session_id: 'sess_1',
      admission_org_id: 'org_fnf',
      admission_cutover_id: 'cut_1',
      admission_routing_mode: 'paid-team-capacity',
      consumer_org_id: 'org_fnf',
      buyer_key_id: 'buyer_1',
      serving_org_id: 'org_innies',
      provider_account_id: 'acct_1',
      token_credential_id: null,
      capacity_owner_user_id: null,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      rate_card_version_id: 'rate_1',
      input_tokens: 10,
      output_tokens: 20,
      usage_units: 30,
      buyer_debit_minor: 90,
      contributor_earnings_minor: 0,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T10:00:00.000Z',
      prompt_preview: 'hello',
      response_preview: 'world',
      route_decision: { reason: 'preferred_provider_selected' },
      projector_states: []
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/requests',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      query: {
        limit: '1',
        cursor: encodedCursor
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);
    await invoke(requestHistoryHandlers[1], req, res);

    expect(runtimeModule.runtime.repos.routingAttribution.listAdminRequestHistory).toHaveBeenCalledWith({
      consumerOrgId: undefined,
      limit: 1,
      cursor: decodedCursor,
      historyScope: 'all'
    });
    expect(res.body).toEqual(expect.objectContaining({
      nextCursor: Buffer.from(JSON.stringify({
        createdAt: '2026-03-20T10:00:00.000Z',
        requestId: 'req_9',
        attemptNo: 3
      }), 'utf8').toString('base64url')
    }));
  });

  it('returns an admin request explanation when present', async () => {
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'getRequestExplanation').mockResolvedValue({
      request_id: 'req_1',
      attempt_no: 1
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/requests/req_1/explanation',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: {
        requestId: 'req_1'
      }
    });
    const res = createMockRes();

    await invoke(requestExplanationHandlers[0], req, res);
    await invoke(requestExplanationHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      request: expect.objectContaining({ request_id: 'req_1' })
    }));
  });

  it('lists financially unfinalized requests for operator retry', async () => {
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listFinanciallyUnfinalizedRequests').mockResolvedValue([{
      request_id: 'req_missing',
      attempt_no: 2,
      org_id: 'org_fnf'
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/requests/unfinalized',
      headers: {
        authorization: 'Bearer in_admin_token'
      }
    });
    const res = createMockRes();

    await invoke(unfinalizedRequestHandlers[0], req, res);
    await invoke(unfinalizedRequestHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      requests: [expect.objectContaining({ request_id: 'req_missing' })]
    });
  });

  it('returns an admin wallet snapshot', async () => {
    vi.spyOn(runtimeModule.runtime.services.wallets, 'getWalletSnapshot').mockResolvedValue({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      balanceMinor: 1250,
      currency: 'USD'
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/wallets/org_fnf',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: {
        walletId: 'org_fnf'
      }
    });
    const res = createMockRes();

    await invoke(walletHandlers[0], req, res);
    await invoke(walletHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      wallet: expect.objectContaining({
        walletId: 'org_fnf',
        balanceMinor: 1250
      })
    }));
  });

  it('returns admin wallet ledger history', async () => {
    vi.spyOn(runtimeModule.runtime.services.wallets, 'listWalletLedger').mockResolvedValue({
      entries: [{
        id: 'wallet_entry_1',
        wallet_id: 'org_fnf',
        effect_type: 'manual_credit',
        amount_minor: 5000
      }],
      nextCursor: null
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/wallets/org_fnf/ledger',
      headers: {
        authorization: 'Bearer in_admin_token'
      },
      params: {
        walletId: 'org_fnf'
      }
    });
    const res = createMockRes();

    await invoke(walletLedgerHandlers[0], req, res);
    await invoke(walletLedgerHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      ledger: [expect.objectContaining({ id: 'wallet_entry_1' })],
      nextCursor: null
    }));
  });

  it('records manual admin wallet adjustments with explicit reasons', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/wallets/org_fnf/adjustments',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz765432'
      },
      params: {
        walletId: 'org_fnf'
      },
      body: {
        actorUserId: '11111111-1111-4111-8111-111111111111',
        effectType: 'manual_credit',
        amountMinor: 5000,
        reason: 'usdc top-up',
        metadata: {
          source: 'admin_console'
        }
      }
    });
    const res = createMockRes();

    await invoke(walletAdjustmentHandlers[0], req, res);
    await invoke(walletAdjustmentHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    const adjustmentCall = vi.mocked(runtimeModule.runtime.services.wallets.recordManualAdjustment).mock.calls[0]?.[0];
    expect(adjustmentCall).toEqual(expect.objectContaining({
      entryId: stableUuid('admin_wallet_adjustment_v1:org_innies:abcdefghijklmnopqrstuvwxyz765432'),
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      actorApiKeyId: '99999999-9999-4999-8999-999999999999',
      effectType: 'manual_credit',
      amountMinor: 5000,
      reason: 'usdc top-up'
    }));
    expect(adjustmentCall?.actorUserId).toBeUndefined();
  });

  it('lists wallet projector backlog rows for operators', async () => {
    vi.spyOn(runtimeModule.runtime.services.wallets, 'listWalletProjectionBacklog').mockResolvedValue([{
      metering_event_id: 'meter_7',
      projector: 'wallet',
      state: 'needs_operator_correction'
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/metering/projectors/wallet',
      headers: {
        authorization: 'Bearer in_admin_token'
      }
    });
    const res = createMockRes();

    await invoke(walletProjectorHandlers[0], req, res);
    await invoke(walletProjectorHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      rows: [expect.objectContaining({ metering_event_id: 'meter_7' })]
    });
  });

  it('requeues a stuck wallet projector row', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/metering/projectors/wallet/meter_7/retry',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz765431'
      },
      params: {
        meteringEventId: 'meter_7'
      },
      body: {}
    });
    const res = createMockRes();

    await invoke(walletProjectorRetryHandlers[0], req, res);
    await invoke(walletProjectorRetryHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(runtimeModule.runtime.services.wallets.retryWalletProjection).toHaveBeenCalledWith('meter_7');
  });

  it('lists rate-card versions', async () => {
    vi.spyOn(runtimeModule.runtime.repos.rateCards, 'listVersions').mockResolvedValue([{
      id: 'rate_1',
      version_key: 'pilot-v1'
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/admin/rate-cards',
      headers: {
        authorization: 'Bearer in_admin_token'
      }
    });
    const res = createMockRes();

    await invoke(rateCardListHandlers[0], req, res);
    await invoke(rateCardListHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      versions: [expect.objectContaining({ id: 'rate_1' })]
    });
  });

  it('creates a rate-card version with line items', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/rate-cards',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123457'
      },
      body: {
        versionKey: 'pilot-v1',
        effectiveAt: '2026-03-20T00:00:00.000Z',
        lineItems: [{
          provider: 'anthropic',
          modelPattern: '*',
          routingMode: 'paid-team-capacity',
          buyerDebitMinorPerUnit: 3,
          contributorEarningsMinorPerUnit: 0
        }]
      }
    });
    const res = createMockRes();

    await invoke(rateCardCreateHandlers[0], req, res);
    await invoke(rateCardCreateHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      version: expect.objectContaining({ id: 'rate_1' }),
      lineItems: [expect.objectContaining({ id: 'line_1' })]
    }));
  });

  it('accepts served-request retry corrections through the canonical metering alias', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/admin/metering/corrections',
      headers: {
        authorization: 'Bearer in_admin_token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      },
      body: {
        action: 'served_request_retry',
        event: {
          requestId: 'req_1',
          attemptNo: 1,
          orgId: '11111111-1111-4111-8111-111111111111',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inputTokens: 10,
          outputTokens: 20,
          usageUnits: 30,
          retailEquivalentMinor: 90,
          admissionRoutingMode: 'paid-team-capacity',
          rateCardVersionId: '22222222-2222-4222-8222-222222222222'
        }
      }
    });
    const res = createMockRes();

    await invoke(meteringCorrectionHandlers[0], req, res);
    await invoke(meteringCorrectionHandlers[1], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      id: 'usage_1',
      entryType: 'usage'
    }));
    expect(runtimeModule.runtime.services.metering.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_1',
      admissionRoutingMode: 'paid-team-capacity'
    }));
  });
});
