import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ORG_REVEAL_COOKIE_NAME,
  ORG_SESSION_COOKIE_NAME
} from '../src/services/org/orgSessionCookie.js';
import { AppError } from '../src/utils/errors.js';

type OrgAuthRouteModule = typeof import('../src/routes/orgAuth.js');
type OrgAccessRouteModule = typeof import('../src/routes/orgAccess.js');
type OrgManagementRouteModule = typeof import('../src/routes/orgManagement.js');
type OrgAnalyticsRouteModule = typeof import('../src/routes/orgAnalytics.js');

type MockReq = {
  method: string;
  path: string;
  originalUrl: string;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  header: (name: string) => string | undefined;
};

type MockRes = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  setHeader: (name: string, value: string | string[]) => void;
  status: (code: number) => MockRes;
  json: (payload: unknown) => void;
  send: (payload: unknown) => void;
  redirect: (code: number, location: string) => void;
};

function createMockReq(input: {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
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
    setHeader(name: string, value: string | string[]) {
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

async function invokeHandlers(
  handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>,
  req: MockReq,
  res: MockRes
): Promise<void> {
  for (const handle of handlers) {
    if (res.writableEnded) break;
    await invoke(handle, req, res);
  }
}

function getRouteHandlers(router: any, routePath: string, method: 'get' | 'post') {
  const layer = router.stack.find((entry: any) => entry?.route?.path === routePath && entry?.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${routePath}`);
  return layer.route.stack.map((stackEntry: any) => stackEntry.handle);
}

function createDeps() {
  const orgs = new Map([
    ['acme', { id: 'org_1', slug: 'acme', name: 'Acme', ownerUserId: 'user_owner' }],
    ['beta', { id: 'org_2', slug: 'beta', name: 'Beta', ownerUserId: 'user_beta_owner' }],
    ['team-seller', { id: 'org_3', slug: 'team-seller', name: 'Team Seller Org', ownerUserId: 'user_internal_owner' }]
  ]);

  const orgGithubAuth = {
    buildAuthorizationUrl: vi.fn().mockReturnValue('https://github.com/login/oauth/authorize?state=test-state'),
    finishOauthCallback: vi.fn().mockResolvedValue({
      sessionToken: 'signed-org-session',
      session: {
        actorUserId: 'user_owner',
        githubLogin: 'owner-login'
      },
      authResolution: {
        kind: 'active_membership',
        orgId: 'org_1',
        orgSlug: 'acme',
        orgName: 'Acme',
        userId: 'user_owner',
        membershipId: 'membership_owner',
        isOwner: true
      },
      returnTo: '/acme'
    })
  };

  const orgSessions = {
    readSession: vi.fn().mockReturnValue({
      actorUserId: 'user_owner',
      githubLogin: 'owner-login',
      issuedAt: '2026-03-24T00:00:00.000Z',
      expiresAt: '2026-03-24T12:00:00.000Z'
    })
  };

  const orgAccess = {
    findOrgBySlug: vi.fn(async (slug: string) => orgs.get(slug) ?? null),
    listActiveOrgsForUser: vi.fn(async (userId: string) => {
      if (userId === 'user_owner') {
        return [
          {
            orgId: 'org_1',
            orgSlug: 'acme',
            orgName: 'Acme',
            membershipId: 'membership_owner',
            isOwner: true
          },
          {
            orgId: 'org_3',
            orgSlug: 'team-seller',
            orgName: 'Team Seller Org',
            membershipId: 'membership_internal',
            isOwner: false
          }
        ];
      }
      return [];
    }),
    findAuthResolutionBySlugAndGithubLogin: vi.fn(async (input: { orgSlug: string; githubLogin: string }) => {
      if (input.orgSlug === 'acme') {
        return {
          kind: 'active_membership',
          orgId: 'org_1',
          orgSlug: 'acme',
          orgName: 'Acme',
          userId: 'user_owner',
          membershipId: 'membership_owner',
          isOwner: true
        };
      }
      if (input.orgSlug === 'beta') {
        return {
          kind: 'no_access',
          orgId: 'org_2',
          orgSlug: 'beta',
          orgName: 'Beta'
        };
      }
      if (input.orgSlug === 'team-seller') {
        return {
          kind: 'active_membership',
          orgId: 'org_3',
          orgSlug: 'team-seller',
          orgName: 'Team Seller Org',
          userId: 'user_owner',
          membershipId: 'membership_internal',
          isOwner: false
        };
      }
      return { kind: 'org_not_found' };
    }),
    listMembers: vi.fn(async (orgId: string) => {
      if (orgId === 'org_1') {
        return [
          {
            userId: 'user_owner',
            githubLogin: 'owner-login',
            membershipId: 'membership_owner',
            isOwner: true
          },
          {
            userId: 'user_member',
            githubLogin: 'member-login',
            membershipId: 'membership_member',
            isOwner: false
          }
        ];
      }
      return [];
    })
  };

  const orgInvites = {
    listPendingByOrg: vi.fn().mockResolvedValue([
      {
        inviteId: 'invite_1',
        githubLogin: 'pending-login',
        createdAt: '2026-03-24T00:00:00.000Z',
        createdByUserId: 'user_owner'
      }
    ])
  };

  const orgTokens = {
    listOrgTokens: vi.fn().mockResolvedValue([
      {
        tokenId: 'token_1',
        provider: 'openai',
        status: 'paused',
        createdByUserId: 'user_member',
        createdByGithubLogin: 'member-login',
        debugLabel: 'testing-test-codex-main',
        fiveHourReservePercent: 15,
        sevenDayReservePercent: 25
      }
    ])
  };

  const orgMemberships = {
    createOrg: vi.fn().mockResolvedValue({
      orgId: 'org_created',
      orgSlug: 'new-org',
      reveal: {
        buyerKey: 'in_live_created',
        reason: 'org_created'
      }
    }),
    createInvite: vi.fn().mockResolvedValue({
      kind: 'invite_created',
      inviteId: 'invite_created',
      createdFresh: true
    }),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    acceptInvite: vi.fn().mockResolvedValue({
      kind: 'invite_accepted',
      membershipId: 'membership_member',
      reveal: {
        buyerKey: 'in_live_member',
        reason: 'invite_accepted'
      }
    }),
    leaveOrg: vi.fn().mockResolvedValue({
      membershipId: 'membership_member'
    }),
    removeMember: vi.fn().mockResolvedValue({
      membershipId: 'membership_member'
    })
  };

  const orgTokenManagement = {
    addOrgToken: vi.fn().mockResolvedValue({ tokenId: 'token_new' }),
    updateOrgTokenReserve: vi.fn().mockResolvedValue({
      tokenId: 'token_1',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48
    }),
    probeOrgToken: vi.fn().mockResolvedValue({
      tokenId: 'token_1',
      probeOk: true,
      reactivated: false,
      status: 'active',
      reason: 'ok',
      nextProbeAt: null
    }),
    refreshOrgToken: vi.fn().mockResolvedValue(undefined),
    removeOrgToken: vi.fn().mockResolvedValue(undefined)
  };

  const orgBuyerKeys = {
    listOrgKeysWithMembers: vi.fn(async (orgId: string) => {
      if (orgId === 'org_1') {
        return [
          {
            apiKeyId: 'buyer_owner',
            membershipId: 'membership_owner',
            userId: 'user_owner',
            githubLogin: 'owner-login',
            revokedAt: null
          },
          {
            apiKeyId: 'buyer_member_old',
            membershipId: 'membership_member',
            userId: 'user_member',
            githubLogin: 'member-login',
            revokedAt: '2026-03-24T00:00:00.000Z'
          }
        ];
      }
      if (orgId === 'org_3') {
        return [
          {
            apiKeyId: 'buyer_internal',
            membershipId: 'membership_internal',
            userId: 'user_owner',
            githubLogin: 'owner-login',
            revokedAt: null
          }
        ];
      }
      return [];
    })
  };

  const apiKeys = {
    setBuyerProviderPreference: vi.fn().mockResolvedValue(true)
  };

  const analytics = {
    getSystemSummary: vi.fn().mockResolvedValue({
      total_requests: 3,
      total_usage_units: 12,
      active_tokens: 1,
      maxed_tokens: 0,
      total_tokens: 1,
      maxed_events_7d: 0,
      error_rate: 0,
      fallback_rate: 0,
      by_provider: [],
      by_model: [],
      by_source: []
    }),
    getTokenUsage: vi.fn().mockResolvedValue([
      {
        credential_id: '11111111-1111-4111-8111-111111111111',
        debug_label: 'alpha',
        provider: 'openai',
        status: 'active',
        attempts: 4,
        requests: 3,
        usage_units: 12,
        by_source: []
      }
    ]),
    getTokenHealth: vi.fn().mockResolvedValue([]),
    getTokenRouting: vi.fn().mockResolvedValue([]),
    getBuyers: vi.fn().mockResolvedValue([
      {
        api_key_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'buyer-alpha',
        org_id: 'org_1',
        org_label: 'Acme',
        effective_provider: 'openai',
        requests: 3,
        attempts: 3,
        usage_units: 12,
        by_source: []
      }
    ]),
    getBuyerTimeSeries: vi.fn().mockResolvedValue([
      {
        bucket: '2026-03-24T00:00:00.000Z',
        api_key_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        request_count: 3,
        usage_units: 12,
        error_rate: 0,
        latency_p50_ms: 140
      }
    ]),
    getAnomalies: vi.fn().mockResolvedValue({
      checks: {},
      ok: true
    }),
    getEvents: vi.fn().mockResolvedValue([
      {
        id: 'event_1',
        event_type: 'maxed',
        created_at: '2026-03-24T00:00:00.000Z',
        provider: 'openai',
        credential_id: '11111111-1111-4111-8111-111111111111',
        credential_label: 'alpha',
        summary: 'credential maxed',
        severity: 'warn',
        status_code: 401,
        reason: 'upstream_401_consecutive_failure',
        metadata: { threshold: 3 }
      }
    ]),
    getTimeSeries: vi.fn().mockResolvedValue([
      {
        bucket: '2026-03-24T00:00:00.000Z',
        request_count: 1,
        usage_units: 2,
        error_rate: 0,
        latency_p50_ms: 110
      }
    ])
  };

  return {
    deps: {
      orgGithubAuth,
      orgSessions,
      orgAccess,
      orgInvites,
      orgTokens,
      orgBuyerKeys,
      apiKeys,
      orgMemberships,
      orgTokenManagement,
      analytics
    },
    orgGithubAuth,
    orgSessions,
    orgAccess,
    orgInvites,
    orgTokens,
    orgBuyerKeys,
    apiKeys,
    orgMemberships,
    orgTokenManagement,
    analytics
  };
}

describe('org routes', () => {
  let createOrgAuthRouter: OrgAuthRouteModule['createOrgAuthRouter'];
  let createOrgAccessRouter: OrgAccessRouteModule['createOrgAccessRouter'];
  let createOrgManagementRouter: OrgManagementRouteModule['createOrgManagementRouter'];
  let createOrgAnalyticsRouter: OrgAnalyticsRouteModule['createOrgAnalyticsRouter'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    ({ createOrgAuthRouter } = await import('../src/routes/orgAuth.js'));
    ({ createOrgAccessRouter } = await import('../src/routes/orgAccess.js'));
    ({ createOrgManagementRouter } = await import('../src/routes/orgManagement.js'));
    ({ createOrgAnalyticsRouter } = await import('../src/routes/orgAnalytics.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts GitHub auth with the requested org return path', async () => {
    const { deps, orgGithubAuth } = createDeps();
    const router = createOrgAuthRouter(deps as any);
    const req = createMockReq({
      method: 'GET',
      path: '/v1/org/auth/github/start',
      query: { returnTo: '/acme' }
    });
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/org/auth/github/start', 'get'), req, res);

    expect(orgGithubAuth.buildAuthorizationUrl).toHaveBeenCalledWith({ returnTo: '/acme' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://github.com/login/oauth/authorize?state=test-state');
  });

  it('completes the GitHub callback, sets the org session cookie, and redirects back to the org route', async () => {
    const { deps, orgGithubAuth } = createDeps();
    const router = createOrgAuthRouter(deps as any);
    process.env.PILOT_UI_BASE_URL = 'https://www.innies.computer';
    const req = createMockReq({
      method: 'GET',
      path: '/v1/org/auth/github/callback',
      query: {
        code: 'oauth-code',
        state: 'oauth-state'
      }
    });
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/org/auth/github/callback', 'get'), req, res);

    expect(orgGithubAuth.finishOauthCallback).toHaveBeenCalledWith({
      code: 'oauth-code',
      state: 'oauth-state'
    });
    expect(String(res.headers['set-cookie'])).toContain(`${ORG_SESSION_COOKIE_NAME}=`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.innies.computer/acme');
  });

  it('returns the current org session with every active org membership when the org session cookie is present', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgAuthRouter(deps as any);
    const req = createMockReq({
      method: 'GET',
      path: '/v1/org/session',
      headers: {
        cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session`
      }
    });
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/org/session', 'get'), req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      session: {
        actorUserId: 'user_owner',
        githubLogin: 'owner-login',
        issuedAt: '2026-03-24T00:00:00.000Z',
        expiresAt: '2026-03-24T12:00:00.000Z',
        activeOrgs: [
          {
            id: 'org_1',
            slug: 'acme',
            name: 'Acme',
            isOwner: true
          },
          {
            id: 'org_3',
            slug: 'team-seller',
            name: 'Team Seller Org',
            isOwner: false
          }
        ]
      }
    });
    expect(orgAccess.listActiveOrgsForUser).toHaveBeenCalledWith('user_owner');
  });

  it('returns not_found for a nonexistent org slug and sign_in_required when the org exists but there is no session', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgAccessRouter(deps as any);

    const missingReq = createMockReq({
      method: 'GET',
      path: '/v1/orgs/missing/access',
      params: { slug: 'missing' }
    });
    const missingRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/access', 'get'), missingReq, missingRes);

    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.body).toEqual({ kind: 'not_found' });

    orgAccess.findOrgBySlug.mockResolvedValueOnce({
      id: 'org_1',
      slug: 'acme',
      name: 'Acme',
      ownerUserId: 'user_owner'
    });

    const unauthedReq = createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/access',
      params: { slug: 'acme' }
    });
    const unauthedRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/access', 'get'), unauthedReq, unauthedRes);

    expect(unauthedRes.statusCode).toBe(200);
    expect(unauthedRes.body).toEqual({
      kind: 'sign_in_required',
      org: {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme'
      },
      authStartUrl: '/v1/org/auth/github/start?returnTo=%2Facme'
    });
  });

  it('maps org access responses for not_invited, pending_invite, active_membership, and route-scoped multi-org resolution', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgAccessRouter(deps as any);

    orgAccess.findAuthResolutionBySlugAndGithubLogin
      .mockResolvedValueOnce({
        kind: 'no_access',
        orgId: 'org_1',
        orgSlug: 'acme',
        orgName: 'Acme'
      })
      .mockResolvedValueOnce({
        kind: 'pending_invite',
        orgId: 'org_1',
        orgSlug: 'acme',
        orgName: 'Acme',
        inviteId: 'invite_pending'
      })
      .mockResolvedValueOnce({
        kind: 'active_membership',
        orgId: 'org_1',
        orgSlug: 'acme',
        orgName: 'Acme',
        userId: 'user_owner',
        membershipId: 'membership_owner',
        isOwner: true
      })
      .mockImplementation(async ({ orgSlug }: { orgSlug: string }) => {
        if (orgSlug === 'acme') {
          return {
            kind: 'active_membership',
            orgId: 'org_1',
            orgSlug: 'acme',
            orgName: 'Acme',
            userId: 'user_owner',
            membershipId: 'membership_owner',
            isOwner: true
          };
        }
        return {
          kind: 'no_access',
          orgId: 'org_2',
          orgSlug: 'beta',
          orgName: 'Beta'
        };
      });

    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };
    const accessHandlers = getRouteHandlers(router as any, '/v1/orgs/:slug/access', 'get');

    const notInvitedRes = createMockRes();
    await invokeHandlers(accessHandlers, createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/access',
      headers,
      params: { slug: 'acme' }
    }), notInvitedRes);
    expect(notInvitedRes.body).toEqual({
      kind: 'not_invited',
      org: {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme'
      }
    });

    const pendingRes = createMockRes();
    await invokeHandlers(accessHandlers, createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/access',
      headers,
      params: { slug: 'acme' }
    }), pendingRes);
    expect(pendingRes.body).toEqual({
      kind: 'pending_invite',
      org: {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme'
      },
      invite: {
        inviteId: 'invite_pending',
        githubLogin: 'owner-login'
      }
    });

    const activeRes = createMockRes();
    await invokeHandlers(accessHandlers, createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/access',
      headers,
      params: { slug: 'acme' }
    }), activeRes);
    expect(activeRes.body).toEqual({
      kind: 'active_membership',
      org: {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme'
      },
      membership: {
        membershipId: 'membership_owner',
        isOwner: true
      }
    });

    const acmeRes = createMockRes();
    await invokeHandlers(accessHandlers, createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/access',
      headers,
      params: { slug: 'acme' }
    }), acmeRes);
    const betaRes = createMockRes();
    await invokeHandlers(accessHandlers, createMockReq({
      method: 'GET',
      path: '/v1/orgs/beta/access',
      headers,
      params: { slug: 'beta' }
    }), betaRes);

    expect(acmeRes.body).toEqual(expect.objectContaining({ kind: 'active_membership' }));
    expect(betaRes.body).toEqual(expect.objectContaining({ kind: 'not_invited' }));
    expect(orgAccess.findAuthResolutionBySlugAndGithubLogin).toHaveBeenLastCalledWith({
      orgSlug: 'beta',
      githubLogin: 'owner-login'
    });
  });

  it('aliases /v1/orgs/innies/access to the internal org slug while preserving the /innies route contract', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgAccessRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/access', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/innies/access',
      headers,
      params: { slug: 'innies' }
    }), res);

    expect(res.body).toEqual({
      kind: 'active_membership',
      org: {
        id: 'org_3',
        slug: 'innies',
        name: 'Team Seller Org'
      },
      membership: {
        membershipId: 'membership_internal',
        isOwner: false
      }
    });
    expect(orgAccess.findAuthResolutionBySlugAndGithubLogin).toHaveBeenLastCalledWith({
      orgSlug: 'team-seller',
      githubLogin: 'owner-login'
    });
  });

  it('keeps repository method binding intact while resolving the /innies alias', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgAccessRouter({
      ...deps,
      orgAccess: {
        ...orgAccess,
        orgs: new Map([
          ['team-seller', { id: 'org_3', slug: 'team-seller', name: 'Team Seller Org', ownerUserId: 'user_internal_owner' }]
        ]),
        async findOrgBySlug(this: {
          orgs: Map<string, { id: string; slug: string; name: string; ownerUserId: string }>;
        }, slug: string) {
          return this.orgs.get(slug) ?? null;
        }
      }
    } as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/access', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/innies/access',
      headers,
      params: { slug: 'innies' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      kind: 'active_membership',
      org: expect.objectContaining({
        slug: 'innies'
      })
    }));
  });

  it('creates orgs and fresh invite acceptances with reveal cookies while never returning plaintext buyer keys in JSON', async () => {
    const { deps, orgMemberships } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const createRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs',
      headers,
      body: { orgName: 'New Org' }
    }), createRes);

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body).toEqual({ orgSlug: 'new-org' });
    expect(String(createRes.headers['set-cookie'])).toContain(`${ORG_REVEAL_COOKIE_NAME}=`);
    expect(JSON.stringify(createRes.body)).not.toContain('in_live_created');

    orgMemberships.acceptInvite.mockResolvedValueOnce({
      kind: 'invite_accepted',
      membershipId: 'membership_member',
      reveal: {
        buyerKey: 'in_live_member',
        reason: 'invite_accepted'
      }
    });

    const acceptRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/invites/accept', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/invites/accept',
      headers,
      params: { slug: 'acme' }
    }), acceptRes);

    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.body).toEqual({ orgSlug: 'acme' });
    expect(String(acceptRes.headers['set-cookie'])).toContain(`${ORG_REVEAL_COOKIE_NAME}=`);
    expect(JSON.stringify(acceptRes.body)).not.toContain('in_live_member');
  });

  it('lets an active member lock in their own buyer-key OpenClaw preference', async () => {
    const { deps, apiKeys, orgBuyerKeys } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };
    const res = createMockRes();

    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/buyer-key/provider-preference', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/team-seller/buyer-key/provider-preference',
      headers,
      params: { slug: 'team-seller' },
      body: { preferredProvider: 'codex' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(orgBuyerKeys.listOrgKeysWithMembers).toHaveBeenCalledWith('org_3');
    expect(apiKeys.setBuyerProviderPreference).toHaveBeenCalledWith({
      id: 'buyer_internal',
      preferredProvider: 'openai'
    });
    expect(res.body).toEqual({
      ok: true,
      apiKeyId: 'buyer_internal',
      orgId: 'org_3',
      preferredProvider: 'openai',
      effectiveProvider: 'openai',
      source: 'explicit'
    });
  });

  it('returns duplicate invite acceptance without a reveal cookie', async () => {
    const { deps, orgMemberships } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgMemberships.acceptInvite.mockResolvedValueOnce({
      kind: 'already_active_member',
      membershipId: 'membership_owner'
    });

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/invites/accept', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/invites/accept',
      headers,
      params: { slug: 'acme' }
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ orgSlug: 'acme' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts /v1/orgs/innies invite actions against the internal org slug but keeps the route slug in the response and cookie', async () => {
    const { deps, orgMemberships } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgMemberships.acceptInvite.mockResolvedValueOnce({
      kind: 'invite_accepted',
      membershipId: 'membership_internal',
      reveal: {
        buyerKey: 'in_live_internal',
        reason: 'invite_accepted'
      }
    });

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/invites/accept', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/innies/invites/accept',
      headers,
      params: { slug: 'innies' }
    }), res);

    expect(orgMemberships.acceptInvite).toHaveBeenCalledWith({
      orgSlug: 'team-seller',
      actorUserId: 'user_owner',
      actorGithubLogin: 'owner-login'
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ orgSlug: 'innies' });
    expect(String(res.headers['set-cookie'])).toContain('Path=/innies');
  });

  it('surfaces reserved/conflicting slug rejection on org creation', async () => {
    const { deps, orgMemberships } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgMemberships.createOrg.mockRejectedValueOnce(
      new AppError('invalid_request', 409, 'Org slug is reserved')
    );

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs',
      headers,
      body: { orgName: 'Innies' }
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'invalid_request',
      message: 'Org slug is reserved',
      details: undefined
    });
  });

  it('enforces owner-only invite create/list/revoke access', async () => {
    const { deps, orgAccess } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgAccess.findAuthResolutionBySlugAndGithubLogin.mockResolvedValue({
      kind: 'active_membership',
      orgId: 'org_1',
      orgSlug: 'acme',
      orgName: 'Acme',
      userId: 'user_member',
      membershipId: 'membership_member',
      isOwner: false
    });
    deps.orgSessions.readSession.mockReturnValue({
      actorUserId: 'user_member',
      githubLogin: 'member-login',
      issuedAt: '2026-03-24T00:00:00.000Z',
      expiresAt: '2026-03-24T12:00:00.000Z'
    });

    for (const testCase of [
      { path: '/v1/orgs/:slug/invites', reqPath: '/v1/orgs/acme/invites', method: 'get' as const, body: undefined },
      { path: '/v1/orgs/:slug/invites', reqPath: '/v1/orgs/acme/invites', method: 'post' as const, body: { githubLogin: 'new-user' } },
      { path: '/v1/orgs/:slug/invites/revoke', reqPath: '/v1/orgs/acme/invites/revoke', method: 'post' as const, body: { inviteId: 'invite_1' } }
    ]) {
      const res = createMockRes();
      await invokeHandlers(getRouteHandlers(router as any, testCase.path, testCase.method), createMockReq({
        method: testCase.method.toUpperCase(),
        path: testCase.reqPath,
        headers,
        params: { slug: 'acme' },
        body: testCase.body
      }), res);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual(expect.objectContaining({
        code: 'forbidden'
      }));
    }
  });

  it('returns members, invites, and tokens with the locked response contracts', async () => {
    const { deps } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const membersRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/members', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/members',
      headers,
      params: { slug: 'acme' }
    }), membersRes);
    expect(membersRes.body).toEqual({
      members: [
        {
          userId: 'user_owner',
          githubLogin: 'owner-login',
          membershipId: 'membership_owner',
          isOwner: true
        },
        {
          userId: 'user_member',
          githubLogin: 'member-login',
          membershipId: 'membership_member',
          isOwner: false
        }
      ]
    });

    const invitesRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/invites', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/invites',
      headers,
      params: { slug: 'acme' }
    }), invitesRes);
    expect(invitesRes.body).toEqual({
      invites: [
        {
          inviteId: 'invite_1',
          githubLogin: 'pending-login',
          createdAt: '2026-03-24T00:00:00.000Z'
        }
      ]
    });

    const tokensRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' }
    }), tokensRes);
    expect(tokensRes.body).toEqual({
      tokens: [
        {
          tokenId: 'token_1',
          provider: 'openai',
          status: 'paused',
          createdByUserId: 'user_member',
          createdByGithubLogin: 'member-login',
          debugLabel: 'testing-test-codex-main',
          fiveHourReservePercent: 15,
          sevenDayReservePercent: 25
        }
      ]
    });
  });

  it('adds tokens with required refresh tokens, accepts blank reserve defaults, and rejects invalid input', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const explicitRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        debugLabel: 'testing-test-codex-main',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created',
        fiveHourReservePercent: 10,
        sevenDayReservePercent: 20
      }
    }), explicitRes);
    expect(explicitRes.statusCode).toBe(200);
    expect(explicitRes.body).toEqual({ tokenId: 'token_new' });
    expect(orgTokenManagement.addOrgToken).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      provider: 'openai',
      debugLabel: 'testing-test-codex-main',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created',
      fiveHourReservePercent: 10,
      sevenDayReservePercent: 20
    });

    const blankRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created',
        fiveHourReservePercent: '',
        sevenDayReservePercent: ''
      }
    }), blankRes);
    expect(blankRes.statusCode).toBe(200);
    expect(orgTokenManagement.addOrgToken).toHaveBeenLastCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      provider: 'openai',
      token: 'sk-live-created',
      refreshToken: 'rt-live-created',
      fiveHourReservePercent: undefined,
      sevenDayReservePercent: undefined
    });

    const missingRefreshRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created'
      }
    }), missingRefreshRes);
    expect(missingRefreshRes.statusCode).toBe(400);
    expect(missingRefreshRes.body).toEqual(expect.objectContaining({
      code: 'invalid_request'
    }));

    const invalidRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created',
        sevenDayReservePercent: 101
      }
    }), invalidRes);
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.body).toEqual(expect.objectContaining({
      code: 'invalid_request'
    }));
  });

  it('surfaces duplicate borrowed-token rejection on org token add', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgTokenManagement.addOrgToken.mockRejectedValueOnce(
      new AppError('invalid_request', 409, 'This token is already lent to an org and cannot be added again until it is removed.')
    );

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created'
      }
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'invalid_request',
      message: 'This token is already lent to an org and cannot be added again until it is removed.',
      details: undefined
    });
  });

  it('surfaces duplicate provider-label rejection on org token add', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgTokenManagement.addOrgToken.mockRejectedValueOnce(
      new AppError('invalid_request', 409, 'A token with provider "openai" and label "shirtless" already exists for this org.')
    );

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        debugLabel: 'shirtless',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created'
      }
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'invalid_request',
      message: 'A token with provider "openai" and label "shirtless" already exists for this org.',
      details: undefined
    });
  });

  it('surfaces token preflight rejection on org token add', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    orgTokenManagement.addOrgToken.mockRejectedValueOnce(
      new AppError('invalid_request', 400, 'Codex/OpenAI OAuth token is not valid.')
    );

    const res = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created',
        refreshToken: 'rt-live-created'
      }
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: 'invalid_request',
      message: 'Codex/OpenAI OAuth token is not valid.',
      details: undefined
    });
  });

  it('refreshes and removes tokens through the org token service', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const refreshRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/refresh', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens/token_1/refresh',
      headers,
      params: { slug: 'acme', tokenId: 'token_1' }
    }), refreshRes);
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.body).toEqual({ tokenId: 'token_1', status: 'refreshed' });
    expect(orgTokenManagement.refreshOrgToken).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      tokenId: 'token_1'
    });

    const removeRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/remove', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens/token_1/remove',
      headers,
      params: { slug: 'acme', tokenId: 'token_1' }
    }), removeRes);
    expect(removeRes.statusCode).toBe(200);
    expect(removeRes.body).toEqual({ tokenId: 'token_1', status: 'removed' });
    expect(orgTokenManagement.removeOrgToken).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      tokenId: 'token_1'
    });
  });

  it('updates token reserve floors for owners and rejects non-owner reserve edits', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const updateRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/reserve-floors', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens/token_1/reserve-floors',
      headers,
      params: { slug: 'acme', tokenId: 'token_1' },
      body: {
        fiveHourReservePercent: 22,
        sevenDayReservePercent: 48
      }
    }), updateRes);
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.body).toEqual({
      tokenId: 'token_1',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48
    });
    expect(orgTokenManagement.updateOrgTokenReserve).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      tokenId: 'token_1',
      fiveHourReservePercent: 22,
      sevenDayReservePercent: 48
    });

    const forbiddenRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/reserve-floors', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/team-seller/tokens/token_1/reserve-floors',
      headers,
      params: { slug: 'team-seller', tokenId: 'token_1' },
      body: {
        fiveHourReservePercent: 10,
        sevenDayReservePercent: 20
      }
    }), forbiddenRes);
    expect(forbiddenRes.statusCode).toBe(403);
    expect(forbiddenRes.body).toEqual({
      code: 'forbidden',
      message: 'Owner access required',
      details: undefined
    });
    expect(orgTokenManagement.updateOrgTokenReserve).toHaveBeenCalledTimes(1);
  });

  it('lets owners manually probe org tokens and rejects non-owner probes', async () => {
    const { deps, orgTokenManagement } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const probeRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/probe', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens/token_1/probe',
      headers,
      params: { slug: 'acme', tokenId: 'token_1' }
    }), probeRes);
    expect(probeRes.statusCode).toBe(200);
    expect(probeRes.body).toEqual({
      tokenId: 'token_1',
      probeOk: true,
      reactivated: false,
      status: 'active',
      reason: 'ok',
      nextProbeAt: null
    });
    expect(orgTokenManagement.probeOrgToken).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      tokenId: 'token_1'
    });

    const forbiddenRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens/:tokenId/probe', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/team-seller/tokens/token_1/probe',
      headers,
      params: { slug: 'team-seller', tokenId: 'token_1' }
    }), forbiddenRes);
    expect(forbiddenRes.statusCode).toBe(403);
    expect(forbiddenRes.body).toEqual({
      code: 'forbidden',
      message: 'Owner access required',
      details: undefined
    });
    expect(orgTokenManagement.probeOrgToken).toHaveBeenCalledTimes(1);
  });

  it('handles leave and remove-member flows', async () => {
    const { deps, orgMemberships } = createDeps();
    const router = createOrgManagementRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const leaveRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/leave', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/leave',
      headers,
      params: { slug: 'acme' }
    }), leaveRes);
    expect(leaveRes.body).toEqual({
      membershipId: 'membership_member',
      redirectTo: '/'
    });

    const removeRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/members/:memberUserId/remove', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/members/user_member/remove',
      headers,
      params: { slug: 'acme', memberUserId: 'user_member' }
    }), removeRes);
    expect(removeRes.body).toEqual({
      membershipId: 'membership_member'
    });
    expect(orgMemberships.removeMember).toHaveBeenCalledWith({
      orgSlug: 'acme',
      actorUserId: 'user_owner',
      memberUserId: 'user_member'
    });
  });

  it('serves a full org analytics dashboard snapshot with org-scoped filters', async () => {
    const { deps, analytics } = createDeps();
    const router = createOrgAnalyticsRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const dashboardRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/dashboard', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/analytics/dashboard',
      headers,
      params: { slug: 'acme' },
      query: { window: '1w' }
    }), dashboardRes);
    expect(dashboardRes.statusCode).toBe(200);
    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getTokenUsage).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getTokenHealth).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getTokenRouting).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getBuyers).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getAnomalies).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });
    expect(analytics.getEvents).toHaveBeenCalledWith({
      window: '7d',
      provider: undefined,
      limit: 20,
      orgId: 'org_1'
    });
    expect(dashboardRes.body).toEqual({
      window: '1w',
      effectiveWindow: '7d',
      snapshotAt: expect.any(String),
      summary: expect.objectContaining({
        totalRequests: 3,
        totalUsageUnits: 12,
        activeTokens: 1,
        maxedTokens: 0,
        totalTokens: 1
      }),
      tokens: [
        expect.objectContaining({
          credentialId: '11111111-1111-4111-8111-111111111111',
          debugLabel: 'alpha',
          provider: 'openai',
          requests: 3,
          usageUnits: 12
        })
      ],
      buyers: [
        expect.objectContaining({
          apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          label: 'buyer-alpha',
          orgId: 'org_1',
          effectiveProvider: 'openai'
        })
      ],
      anomalies: {
        checks: {
          missingDebugLabels: 0,
          unresolvedCredentialIdsInTokenModeUsage: 0,
          nullCredentialIdsInRouting: 0,
          staleAggregateWindows: null,
          usageLedgerVsAggregateMismatchCount: null
        },
        ok: true
      },
      events: [
        expect.objectContaining({
          id: 'event_1',
          type: 'maxed',
          provider: 'openai',
          credentialId: '11111111-1111-4111-8111-111111111111'
        })
      ],
      capabilities: {
        supports5hWindow: true,
        buyersComplete: true,
        buyerSeriesAvailable: true,
        lifecycleEventsAvailable: true,
        dashboardSnapshotAvailable: true,
        timeseriesMultiEntityAvailable: false
      },
      warnings: []
    });
  });

  it('routes org token timeseries queries through org-scoped credential filters', async () => {
    const { deps, analytics } = createDeps();
    const router = createOrgAnalyticsRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const timeseriesRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/timeseries', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/analytics/timeseries',
      headers,
      params: { slug: 'acme' },
      query: {
        window: '1w',
        entityType: 'token',
        entityId: '11111111-1111-4111-8111-111111111111',
        metric: 'usageUnits'
      }
    }), timeseriesRes);
    expect(timeseriesRes.statusCode).toBe(200);
    expect(analytics.getTimeSeries).toHaveBeenCalledWith({
      window: '7d',
      granularity: 'hour',
      credentialId: '11111111-1111-4111-8111-111111111111',
      orgId: 'org_1'
    });
    expect(analytics.getBuyerTimeSeries).not.toHaveBeenCalled();
    expect(timeseriesRes.body).toEqual({
      window: '1w',
      effectiveWindow: '7d',
      entityType: 'token',
      entityId: '11111111-1111-4111-8111-111111111111',
      metric: 'usageUnits',
      partial: false,
      warning: null,
      series: [
        {
          timestamp: '2026-03-24T00:00:00.000Z',
          value: 2
        }
      ]
    });
  });

  it('routes org buyer timeseries queries through org-scoped buyer filters', async () => {
    const { deps, analytics } = createDeps();
    const router = createOrgAnalyticsRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const timeseriesRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/timeseries', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/analytics/timeseries',
      headers,
      params: { slug: 'acme' },
      query: {
        window: '24h',
        entityType: 'buyer',
        entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        metric: 'requests'
      }
    }), timeseriesRes);
    expect(timeseriesRes.statusCode).toBe(200);
    expect(analytics.getBuyerTimeSeries).toHaveBeenCalledWith({
      window: '24h',
      granularity: '15m',
      apiKeyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      orgId: 'org_1'
    });
    expect(analytics.getTimeSeries).not.toHaveBeenCalled();
    expect(timeseriesRes.body).toEqual({
      window: '24h',
      effectiveWindow: '24h',
      entityType: 'buyer',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metric: 'requests',
      partial: false,
      warning: null,
      series: [
        {
          timestamp: '2026-03-24T00:00:00.000Z',
          value: 3
        }
      ]
    });
  });

  it('routes /v1/orgs/innies analytics through the internal org slug', async () => {
    const { deps, analytics } = createDeps();
    const router = createOrgAnalyticsRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const dashboardRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/dashboard', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/innies/analytics/dashboard',
      headers,
      params: { slug: 'innies' }
    }), dashboardRes);

    expect(dashboardRes.statusCode).toBe(200);
    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      orgId: 'org_3'
    });
  });
});
