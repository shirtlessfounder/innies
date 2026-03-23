import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';
import { sha256Hex, stableJson } from '../src/utils/hash.js';

type RuntimeModule = typeof import('../src/services/runtime.js');
type PilotRouteModule = typeof import('../src/routes/pilot.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
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
  redirect: (code: number, location: string) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
}): MockReq {
  const lower = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
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
    },
    redirect(code: number, location: string) {
      this.statusCode = code;
      this.headers.location = location;
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

describe('pilot routes', () => {
  let runtimeModule: RuntimeModule;
  let sessionHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let requestHistoryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let connectedAccountsHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let walletLedgerHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let authStartHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let authCallbackHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let logoutHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let paymentsStateHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let paymentsSetupHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let paymentsTopUpHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let paymentsRemoveHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let paymentsAutoRechargeHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let earningsSummaryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let earningsHistoryHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let withdrawalsListHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;
  let withdrawalsCreateHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    runtimeModule = await import('../src/services/runtime.js');
    const mod = await import('../src/routes/pilot.js') as PilotRouteModule;
    sessionHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session', 'get');
    requestHistoryHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/requests', 'get');
    connectedAccountsHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/connected-accounts', 'get');
    walletHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/wallet', 'get');
    walletLedgerHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/wallet/ledger', 'get');
    authStartHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/auth/github/start', 'get');
    authCallbackHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/auth/github/callback', 'get');
    logoutHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/session/logout', 'post');
    paymentsStateHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/payments', 'get');
    paymentsSetupHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/payments/setup-session', 'post');
    paymentsTopUpHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/payments/top-up-session', 'post');
    paymentsRemoveHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/payments/payment-method/remove', 'post');
    paymentsAutoRechargeHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/payments/auto-recharge', 'post');
    earningsSummaryHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/earnings/summary', 'get');
    earningsHistoryHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/earnings/history', 'get');
    withdrawalsListHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/withdrawals', 'get');
    withdrawalsCreateHandlers = getRouteHandlers(mod.default as any, '/v1/pilot/withdrawals', 'post');
  });

  beforeEach(() => {
    const now = Date.now();
    delete process.env.PILOT_UI_BASE_URL;
    delete process.env.UI_BASE_URL;
    delete process.env.PILOT_GITHUB_CALLBACK_URL;
    vi.restoreAllMocks();
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.withdrawals, 'getContributorSummary').mockResolvedValue({
      pendingMinor: 50,
      withdrawableMinor: 700,
      reservedForPayoutMinor: 0,
      settledMinor: 120,
      adjustedMinor: -10
    });
    vi.spyOn(runtimeModule.runtime.services.payments, 'getFundingState').mockResolvedValue({
      paymentMethod: {
        id: 'paymeth_local_1',
        processor: 'stripe',
        brand: 'visa',
        last4: '4242',
        expMonth: 8,
        expYear: 2030,
        status: 'active'
      },
      autoRecharge: {
        enabled: true,
        amountMinor: 2500,
        currency: 'USD'
      },
      attempts: [{
        id: 'payment_attempt_1',
        kind: 'auto_recharge',
        trigger: 'admission_blocked',
        status: 'succeeded',
        amountMinor: 2500,
        currency: 'USD',
        createdAt: '2026-03-20T10:30:00.000Z',
        updatedAt: '2026-03-20T10:30:10.000Z',
        lastErrorCode: null,
        lastErrorMessage: null
      }]
    } as any);
    vi.spyOn(runtimeModule.runtime.services.payments, 'createSetupSession').mockResolvedValue({
      checkoutUrl: 'https://checkout.stripe.test/setup'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.payments, 'createTopUpSession').mockResolvedValue({
      checkoutUrl: 'https://checkout.stripe.test/topup'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.payments, 'removeStoredPaymentMethod').mockResolvedValue({
      removed: true
    } as any);
    vi.spyOn(runtimeModule.runtime.services.payments, 'updateAutoRechargeSettings').mockResolvedValue({
      enabled: true,
      amountMinor: 2500,
      currency: 'USD'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.withdrawals, 'listContributorHistory').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.services.withdrawals, 'listContributorWithdrawals').mockResolvedValue([]);
    vi.spyOn(runtimeModule.runtime.services.withdrawals, 'createWithdrawalRequest').mockResolvedValue({
      id: 'withdraw_1',
      status: 'requested',
      amount_minor: 250
    } as any);
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
      capacity_owner_user_id: 'user_darryn',
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
    (runtimeModule.runtime.repos.tokenCredentials as any).listByOrg = vi.fn().mockResolvedValue([{
      id: 'cred_1',
      orgId: 'org_fnf',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'sk-ant-oat-pilot',
      refreshToken: 'refresh_1',
      expiresAt: new Date('2026-03-21T00:00:00.000Z'),
      status: 'active',
      rotationVersion: 2,
      createdAt: new Date('2026-03-19T00:00:00.000Z'),
      updatedAt: new Date('2026-03-20T00:00:00.000Z'),
      revokedAt: null,
      monthlyContributionLimitUnits: null,
      monthlyContributionUsedUnits: 0,
      monthlyWindowStartAt: new Date('2026-03-01T00:00:00.000Z'),
      fiveHourReservePercent: 15,
      sevenDayReservePercent: 25,
      debugLabel: 'darryn-claude',
      consecutiveFailureCount: 0,
      consecutiveRateLimitCount: 0,
      lastFailedStatus: null,
      lastFailedAt: null,
      lastRateLimitedAt: null,
      maxedAt: null,
      rateLimitedUntil: null,
      nextProbeAt: null,
      lastProbeAt: null
    }]);
    vi.spyOn(runtimeModule.runtime.repos.tokenCredentialProviderUsage, 'listByTokenCredentialIds').mockResolvedValue([{
      tokenCredentialId: 'cred_1',
      orgId: 'org_fnf',
      provider: 'anthropic',
      usageSource: 'anthropic_oauth_usage',
      fiveHourUtilizationRatio: 0.41,
      fiveHourResetsAt: new Date(now + 2 * 60 * 60 * 1000),
      sevenDayUtilizationRatio: 0.52,
      sevenDayResetsAt: new Date(now + 7 * 24 * 60 * 60 * 1000),
      rawPayload: {},
      fetchedAt: new Date(now - 30 * 1000),
      createdAt: new Date(now - 30 * 1000),
      updatedAt: new Date(now - 30 * 1000)
    }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the current pilot session from a bearer token', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/session',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(sessionHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      session: expect.objectContaining({
        sessionKind: 'darryn_self',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn'
      })
    }));
  });

  it('returns the pilot wallet balance for the effective org', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);
    vi.spyOn(runtimeModule.runtime.services.wallets, 'getWalletSnapshot').mockResolvedValue({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      balanceMinor: 1250,
      currency: 'USD'
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/wallet',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(walletHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      wallet: expect.objectContaining({
        walletId: 'org_fnf',
        balanceMinor: 1250
      })
    }));
  });

  it('returns connected-account inventory for the effective pilot org', async () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/connected-accounts',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(connectedAccountsHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      accounts: [expect.objectContaining({
        credentialId: 'cred_1',
        orgId: 'org_fnf',
        provider: 'anthropic',
        debugLabel: 'darryn-claude',
        status: 'active',
        rawStatus: 'active',
        fiveHourReservePercent: 15,
        sevenDayReservePercent: 25,
        fiveHourUtilizationRatio: 0.41,
        sevenDayUtilizationRatio: 0.52,
        fiveHourContributionCapExhausted: false,
        sevenDayContributionCapExhausted: false
      })]
    });
    expect((runtimeModule.runtime.repos.tokenCredentials as any).listByOrg).toHaveBeenCalledWith('org_fnf');
    expect(runtimeModule.runtime.repos.tokenCredentialProviderUsage.listByTokenCredentialIds).toHaveBeenCalledWith(['cred_1']);
  });

  it('returns post-cutover request history for the effective pilot org', async () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/requests',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);

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

  it('accepts and emits full request-history cursors for pilot-session reads', async () => {
    const decodedCursor = {
      createdAt: '2026-03-19T09:00:00.000Z',
      requestId: 'req_8',
      attemptNo: 2
    };
    const encodedCursor = Buffer.from(JSON.stringify(decodedCursor), 'utf8').toString('base64url');
    vi.spyOn(runtimeModule.runtime.repos.routingAttribution, 'listOrgRequestHistory').mockResolvedValue([{
      request_id: 'req_9',
      attempt_no: 3,
      session_id: 'sess_2',
      admission_org_id: 'org_fnf',
      admission_cutover_id: 'cut_2',
      admission_routing_mode: 'paid-team-capacity',
      consumer_org_id: 'org_fnf',
      buyer_key_id: 'buyer_1',
      serving_org_id: 'org_capacity',
      provider_account_id: 'acct_2',
      token_credential_id: 'cred_2',
      capacity_owner_user_id: 'user_capacity',
      provider: 'openai',
      model: 'gpt-5-codex',
      rate_card_version_id: 'rate_2',
      input_tokens: 101,
      output_tokens: 202,
      usage_units: 303,
      buyer_debit_minor: 404,
      contributor_earnings_minor: 55,
      currency: 'USD',
      metadata: null,
      created_at: '2026-03-20T11:00:00.000Z',
      prompt_preview: 'build',
      response_preview: 'done',
      route_decision: { reason: 'team_capacity_available' },
      projector_states: []
    }] as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/requests',
      headers: {
        authorization: 'Bearer pilot-token'
      },
      query: {
        limit: '1',
        cursor: encodedCursor
      }
    });
    const res = createMockRes();

    await invoke(requestHistoryHandlers[0], req, res);

    expect(runtimeModule.runtime.repos.routingAttribution.listOrgRequestHistory).toHaveBeenCalledWith({
      orgId: 'org_fnf',
      limit: 1,
      cursor: decodedCursor,
      historyScope: 'post_cutover'
    });
    expect(res.body).toEqual(expect.objectContaining({
      orgId: 'org_fnf',
      requests: [expect.objectContaining({ request_id: 'req_9' })],
      nextCursor: Buffer.from(JSON.stringify({
        createdAt: '2026-03-20T11:00:00.000Z',
        requestId: 'req_9',
        attemptNo: 3
      }), 'utf8').toString('base64url')
    }));
  });

  it('returns pilot wallet ledger history for the effective org', async () => {
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readTokenFromRequest').mockReturnValue('pilot-token');
    vi.spyOn(runtimeModule.runtime.services.pilotSessions, 'readSession').mockReturnValue({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null,
      issuedAt: '2026-03-20T00:00:00Z',
      expiresAt: '2026-03-20T01:00:00Z'
    } as any);
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
      path: '/v1/pilot/wallet/ledger',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(walletLedgerHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      ledger: [expect.objectContaining({
        id: 'wallet_entry_1'
      })],
      nextCursor: null
    }));
  });

  it('returns payment-method, auto-recharge, and recent attempt state for the effective wallet', async () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/payments',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(paymentsStateHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      funding: expect.objectContaining({
        paymentMethod: expect.objectContaining({
          id: 'paymeth_local_1',
          brand: 'visa',
          last4: '4242'
        }),
        autoRecharge: expect.objectContaining({
          enabled: true,
          amountMinor: 2500
        }),
        attempts: [expect.objectContaining({
          id: 'payment_attempt_1',
          kind: 'auto_recharge',
          status: 'succeeded'
        })]
      })
    });
    expect(runtimeModule.runtime.services.payments.getFundingState).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf'
    });
  });

  it('creates a setup session for adding a stored payment method', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/setup-session',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json'
      }
    });
    req.body = {
      returnTo: '/pilot'
    };
    const res = createMockRes();

    await invoke(paymentsSetupHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      checkoutUrl: 'https://checkout.stripe.test/setup'
    });
    expect(runtimeModule.runtime.services.payments.createSetupSession).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      requestedByUserId: 'user_darryn',
      returnTo: '/pilot'
    });
  });

  it('creates a manual top-up session against the effective pilot wallet', async () => {
    const idemSession = {
      replay: false,
      input: {
        scope: 'pilot_payment_topup_session_v1',
        tenantScope: 'org_fnf',
        idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
        requestHash: sha256Hex(stableJson({
          effectiveOrgId: 'org_fnf',
          requestedByUserId: 'user_darryn',
          amountMinor: 5000,
          returnTo: '/pilot'
        }))
      }
    } as any;
    const startSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue(idemSession);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/top-up-session',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      }
    });
    req.body = {
      amountMinor: 5000,
      returnTo: '/pilot'
    };
    const res = createMockRes();

    await invoke(paymentsTopUpHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      checkoutUrl: 'https://checkout.stripe.test/topup'
    });
    expect(runtimeModule.runtime.services.payments.createTopUpSession).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      requestedByUserId: 'user_darryn',
      amountMinor: 5000,
      returnTo: '/pilot',
      idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456'
    });
    expect(startSpy).toHaveBeenCalledWith({
      scope: 'pilot_payment_topup_session_v1',
      tenantScope: 'org_fnf',
      idempotencyKey: 'abcdefghijklmnopqrstuvwxyz123456',
      requestHash: sha256Hex(stableJson({
        effectiveOrgId: 'org_fnf',
        requestedByUserId: 'user_darryn',
        amountMinor: 5000,
        returnTo: '/pilot'
      }))
    });
    expect(commitSpy).toHaveBeenCalledWith(idemSession, {
      responseCode: 200,
      responseBody: {
        ok: true,
        checkoutUrl: 'https://checkout.stripe.test/topup'
      },
      responseDigest: sha256Hex(stableJson({
        ok: true,
        checkoutUrl: 'https://checkout.stripe.test/topup'
      })),
      responseRef: 'org_fnf'
    });
  });

  it('replays a manual top-up session without creating a second checkout session', async () => {
    vi.spyOn(runtimeModule.runtime.services.idempotency, 'start').mockResolvedValue({
      replay: true,
      responseCode: 200,
      responseBody: {
        ok: true,
        checkoutUrl: 'https://checkout.stripe.test/topup-replay'
      }
    } as any);
    const commitSpy = vi.spyOn(runtimeModule.runtime.services.idempotency, 'commit').mockResolvedValue(undefined);
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/top-up-session',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json',
        'idempotency-key': 'abcdefghijklmnopqrstuvwxyz123456'
      }
    });
    req.body = {
      amountMinor: 5000,
      returnTo: '/pilot'
    };
    const res = createMockRes();

    await invoke(paymentsTopUpHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-idempotent-replay']).toBe('true');
    expect(res.body).toEqual({
      ok: true,
      checkoutUrl: 'https://checkout.stripe.test/topup-replay'
    });
    expect(runtimeModule.runtime.services.payments.createTopUpSession).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('rejects manual top-up session creation without an idempotency key header', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/top-up-session',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json'
      }
    });
    req.body = {
      amountMinor: 5000,
      returnTo: '/pilot'
    };
    const res = createMockRes();

    await invoke(paymentsTopUpHandlers[0], req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: 'invalid_request',
      message: 'Missing Idempotency-Key header',
      details: undefined
    });
    expect(runtimeModule.runtime.services.payments.createTopUpSession).not.toHaveBeenCalled();
  });

  it('removes the stored payment method through the payment service', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/payment-method/remove',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json'
      }
    });
    req.body = {};
    const res = createMockRes();

    await invoke(paymentsRemoveHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      removed: true
    });
    expect(runtimeModule.runtime.services.payments.removeStoredPaymentMethod).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf'
    });
  });

  it('updates auto-recharge settings for the effective pilot wallet', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/payments/auto-recharge',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json'
      }
    });
    req.body = {
      enabled: true,
      amountMinor: 2500
    };
    const res = createMockRes();

    await invoke(paymentsAutoRechargeHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      autoRecharge: {
        enabled: true,
        amountMinor: 2500,
        currency: 'USD'
      }
    });
    expect(runtimeModule.runtime.services.payments.updateAutoRechargeSettings).toHaveBeenCalledWith({
      walletId: 'org_fnf',
      ownerOrgId: 'org_fnf',
      enabled: true,
      amountMinor: 2500,
      updatedByUserId: 'user_darryn'
    });
  });

  it('redirects to GitHub auth with a signed state token', async () => {
    const buildAuthorizationUrl = vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'buildAuthorizationUrl')
      .mockReturnValue('https://github.com/login/oauth/authorize?state=signed');

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/start',
      query: { returnTo: '/pilot' }
    });
    const res = createMockRes();

    await invoke(authStartHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://github.com/login/oauth/authorize?state=signed');
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: '/pilot' });
  });

  it('drops unsafe external returnTo values before starting GitHub auth', async () => {
    const buildAuthorizationUrl = vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'buildAuthorizationUrl')
      .mockReturnValue('https://github.com/login/oauth/authorize?state=signed');

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/start',
      query: { returnTo: 'https://evil.example.com/phish' }
    });
    const res = createMockRes();

    await invoke(authStartHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: undefined });
  });

  it('drops slash-backslash returnTo values before starting GitHub auth', async () => {
    const buildAuthorizationUrl = vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'buildAuthorizationUrl')
      .mockReturnValue('https://github.com/login/oauth/authorize?state=signed');

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/start',
      query: { returnTo: '/\\evil.example.com' }
    });
    const res = createMockRes();

    await invoke(authStartHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: undefined });
  });

  it('handles the GitHub callback by setting the pilot session cookie and redirecting', async () => {
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    process.env.PILOT_GITHUB_CALLBACK_URL = 'https://api.innies.computer/v1/pilot/auth/github/callback';
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: '/pilot',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.innies.computer/pilot');
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=signed-session-token');
    expect(res.headers['set-cookie']).toContain('Domain=innies.computer');
    expect(res.headers['set-cookie']).toContain('HttpOnly');
  });

  it('defaults the GitHub callback redirect to the canonical prod UI host when no pilot UI env is set', async () => {
    process.env.PILOT_GITHUB_CALLBACK_URL = 'https://api.innies.computer/v1/pilot/auth/github/callback';
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: '/pilot',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.innies.computer/pilot');
    expect(res.headers['set-cookie']).toContain('Domain=innies.computer');
  });

  it('falls back to /pilot when the callback returnTo is unsafe', async () => {
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    process.env.PILOT_GITHUB_CALLBACK_URL = 'https://api.innies.computer/v1/pilot/auth/github/callback';
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: 'https://evil.example.com/phish',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.innies.computer/pilot');
  });

  it('falls back to /pilot when the callback returnTo uses slash-backslash host bypass', async () => {
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    process.env.PILOT_GITHUB_CALLBACK_URL = 'https://api.innies.computer/v1/pilot/auth/github/callback';
    vi.spyOn(runtimeModule.runtime.services.pilotGithubAuth, 'finishOauthCallback').mockResolvedValue({
      sessionToken: 'signed-session-token',
      returnTo: '/\\evil.example.com',
      session: {
        sessionKind: 'darryn_self',
        actorUserId: 'user_darryn',
        effectiveOrgId: 'org_fnf',
        githubLogin: 'darryn',
        userEmail: 'darryn@example.com'
      }
    } as any);

    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/auth/github/callback',
      query: { code: 'oauth-code', state: 'oauth-state' }
    });
    const res = createMockRes();

    await invoke(authCallbackHandlers[0], req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.innies.computer/pilot');
  });

  it('clears the pilot session cookie on logout', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/session/logout'
    });
    const res = createMockRes();

    await invoke(logoutHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('innies_pilot_session=');
    expect(res.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('returns contributor earnings summary in the effective pilot session context', async () => {
    const req = createMockReq({
      method: 'GET',
      path: '/v1/pilot/earnings/summary',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const res = createMockRes();

    await invoke(earningsSummaryHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      summary: {
        pendingMinor: 50,
        withdrawableMinor: 700,
        reservedForPayoutMinor: 0,
        settledMinor: 120,
        adjustedMinor: -10
      }
    });
    expect(runtimeModule.runtime.services.withdrawals.getContributorSummary).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });
  });

  it('passes the effective org boundary into earnings history and withdrawal list reads', async () => {
    const historyReq = createMockReq({
      method: 'GET',
      path: '/v1/pilot/earnings/history',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const historyRes = createMockRes();

    await invoke(earningsHistoryHandlers[0], historyReq, historyRes);

    expect(runtimeModule.runtime.services.withdrawals.listContributorHistory).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });

    const withdrawalsReq = createMockReq({
      method: 'GET',
      path: '/v1/pilot/withdrawals',
      headers: {
        authorization: 'Bearer pilot-token'
      }
    });
    const withdrawalsRes = createMockRes();

    await invoke(withdrawalsListHandlers[0], withdrawalsReq, withdrawalsRes);

    expect(runtimeModule.runtime.services.withdrawals.listContributorWithdrawals).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn'
    });
  });

  it('creates contributor withdrawal requests against the pilot session user and org', async () => {
    const req = createMockReq({
      method: 'POST',
      path: '/v1/pilot/withdrawals',
      headers: {
        authorization: 'Bearer pilot-token',
        'content-type': 'application/json'
      }
    });
    req.body = {
      amountMinor: 250,
      destination: {
        rail: 'manual_usdc',
        address: '0xabc'
      },
      note: 'pilot payout'
    };
    const res = createMockRes();

    await invoke(withdrawalsCreateHandlers[0], req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      withdrawal: expect.objectContaining({
        id: 'withdraw_1',
        status: 'requested',
        amount_minor: 250
      })
    });
    expect(runtimeModule.runtime.services.withdrawals.createWithdrawalRequest).toHaveBeenCalledWith({
      ownerOrgId: 'org_fnf',
      contributorUserId: 'user_darryn',
      requestedByUserId: 'user_darryn',
      amountMinor: 250,
      destination: {
        rail: 'manual_usdc',
        address: '0xabc'
      },
      note: 'pilot payout'
    });
  });
});
