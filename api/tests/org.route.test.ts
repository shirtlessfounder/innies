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
    ['innies', { id: 'org_3', slug: 'innies', name: 'Innies', ownerUserId: 'user_internal_owner' }]
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
      if (input.orgSlug === 'innies') {
        return {
          kind: 'no_access',
          orgId: 'org_3',
          orgSlug: 'innies',
          orgName: 'Innies'
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
        createdByUserId: 'user_member',
        createdByGithubLogin: 'member-login',
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
    refreshOrgToken: vi.fn().mockResolvedValue(undefined),
    removeOrgToken: vi.fn().mockResolvedValue(undefined)
  };

  const analytics = {
    getSystemSummary: vi.fn().mockResolvedValue({
      total_requests: 3,
      total_usage_units: 12
    }),
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
      orgMemberships,
      orgTokenManagement,
      analytics
    },
    orgGithubAuth,
    orgSessions,
    orgAccess,
    orgInvites,
    orgTokens,
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
    expect(res.headers.location).toBe('/acme');
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

  it('treats /v1/orgs/innies/access as org-scoped and requires active internal membership', async () => {
    const { deps } = createDeps();
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
      kind: 'not_invited',
      org: {
        id: 'org_3',
        slug: 'innies',
        name: 'Innies'
      }
    });
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
          createdByUserId: 'user_member',
          createdByGithubLogin: 'member-login',
          fiveHourReservePercent: 15,
          sevenDayReservePercent: 25
        }
      ]
    });
  });

  it('adds tokens with optional reserve values, accepts blank defaults, and rejects out-of-range values', async () => {
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
        token: 'sk-live-created',
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
      token: 'sk-live-created',
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
      fiveHourReservePercent: undefined,
      sevenDayReservePercent: undefined
    });

    const invalidRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/tokens', 'post'), createMockReq({
      method: 'POST',
      path: '/v1/orgs/acme/tokens',
      headers,
      params: { slug: 'acme' },
      body: {
        provider: 'openai',
        token: 'sk-live-created',
        sevenDayReservePercent: 101
      }
    }), invalidRes);
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.body).toEqual(expect.objectContaining({
      code: 'invalid_request'
    }));
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

  it('serves org analytics endpoints with org-scoped filters', async () => {
    const { deps, analytics } = createDeps();
    const router = createOrgAnalyticsRouter(deps as any);
    const headers = { cookie: `${ORG_SESSION_COOKIE_NAME}=signed-org-session` };

    const dashboardRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/dashboard', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/analytics/dashboard',
      headers,
      params: { slug: 'acme' }
    }), dashboardRes);
    expect(dashboardRes.statusCode).toBe(200);
    expect(analytics.getSystemSummary).toHaveBeenCalledWith({
      window: '24h',
      provider: undefined,
      source: undefined,
      orgId: 'org_1'
    });

    const timeseriesRes = createMockRes();
    await invokeHandlers(getRouteHandlers(router as any, '/v1/orgs/:slug/analytics/timeseries', 'get'), createMockReq({
      method: 'GET',
      path: '/v1/orgs/acme/analytics/timeseries',
      headers,
      params: { slug: 'acme' },
      query: { window: '24h', granularity: '15m' }
    }), timeseriesRes);
    expect(timeseriesRes.statusCode).toBe(200);
    expect(analytics.getTimeSeries).toHaveBeenCalledWith({
      window: '24h',
      granularity: '15m',
      provider: undefined,
      source: undefined,
      credentialId: undefined,
      orgId: 'org_1'
    });
  });
});
