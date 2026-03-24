import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/utils/errors.js';

type AdminOrgsRouteModule = typeof import('../src/routes/adminOrgs.js');

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

function createApiKeysRepo(scope: 'admin' | 'buyer_proxy' = 'admin') {
  return {
    findActiveByHash: vi.fn().mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      org_id: '818d0cc7-7ed2-469f-b690-a977e72a921d',
      scope,
      is_active: true,
      expires_at: null,
      preferred_provider: null
    }),
    touchLastUsed: vi.fn().mockResolvedValue(undefined)
  };
}

function createDeps(scope: 'admin' | 'buyer_proxy' = 'admin') {
  const apiKeys = createApiKeysRepo(scope);
  const orgAccess = {
    listOrgs: vi.fn().mockResolvedValue([
      {
        id: 'org_1',
        slug: 'acme',
        name: 'Acme',
        ownerUserId: 'user_owner'
      }
    ]),
    findOrgBySlug: vi.fn().mockResolvedValue({
      id: 'org_1',
      slug: 'acme',
      name: 'Acme',
      ownerUserId: 'user_owner'
    }),
    listMembers: vi.fn().mockResolvedValue([
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
    ])
  };
  const orgInvites = {
    listPendingByOrg: vi.fn().mockResolvedValue([
      {
        inviteId: 'invite_1',
        githubLogin: 'pending-login',
        createdAt: '2026-03-23T10:00:00.000Z',
        createdByUserId: 'user_owner'
      }
    ])
  };
  const orgBuyerKeys = {
    listOrgKeysWithMembers: vi.fn().mockResolvedValue([
      {
        apiKeyId: 'api_key_1',
        membershipId: 'membership_member',
        userId: 'user_member',
        githubLogin: 'member-login',
        revokedAt: null
      }
    ]),
    revokeBuyerKeyById: vi.fn().mockResolvedValue(undefined),
    rotateMembershipBuyerKey: vi.fn().mockResolvedValue({
      apiKeyId: 'api_key_rotated',
      plaintextKey: 'in_live_rotated'
    })
  };
  const orgTokens = {
    listOrgTokens: vi.fn().mockResolvedValue([
      {
        tokenId: 'token_1',
        provider: 'anthropic',
        createdByUserId: 'user_member',
        createdByGithubLogin: 'member-login',
        fiveHourReservePercent: 15,
        sevenDayReservePercent: 25
      }
    ])
  };

  return {
    deps: {
      apiKeys: apiKeys as any,
      orgAccess: orgAccess as any,
      orgInvites: orgInvites as any,
      orgBuyerKeys: orgBuyerKeys as any,
      orgTokens: orgTokens as any
    },
    apiKeys,
    orgAccess,
    orgInvites,
    orgBuyerKeys,
    orgTokens
  };
}

describe('admin org visibility routes', () => {
  let createAdminOrgsRouter: AdminOrgsRouteModule['createAdminOrgsRouter'];

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/innies_test';
    process.env.SELLER_SECRET_ENC_KEY_B64 = process.env.SELLER_SECRET_ENC_KEY_B64 || Buffer.alloc(32, 7).toString('base64');
    ({ createAdminOrgsRouter } = await import('../src/routes/adminOrgs.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists orgs, members, invites, buyer keys, and token inventory', async () => {
    const { deps, orgAccess, orgInvites, orgBuyerKeys, orgTokens } = createDeps();
    const router = createAdminOrgsRouter(deps);

    const authHeaders = { authorization: 'Bearer in_admin_token' };

    const orgsRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs', 'get'),
      createMockReq({ method: 'GET', path: '/v1/admin/orgs', headers: authHeaders }),
      orgsRes
    );
    expect(orgsRes.statusCode).toBe(200);
    expect(orgsRes.body).toEqual({
      orgs: [{
        id: 'org_1',
        slug: 'acme',
        name: 'Acme',
        ownerUserId: 'user_owner'
      }]
    });

    const membersRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/members', 'get'),
      createMockReq({
        method: 'GET',
        path: '/v1/admin/orgs/acme/members',
        headers: authHeaders,
        params: { slug: 'acme' }
      }),
      membersRes
    );
    expect(membersRes.statusCode).toBe(200);
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
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/invites', 'get'),
      createMockReq({
        method: 'GET',
        path: '/v1/admin/orgs/acme/invites',
        headers: authHeaders,
        params: { slug: 'acme' }
      }),
      invitesRes
    );
    expect(invitesRes.statusCode).toBe(200);
    expect(invitesRes.body).toEqual({
      invites: [{
        inviteId: 'invite_1',
        githubLogin: 'pending-login',
        createdAt: '2026-03-23T10:00:00.000Z',
        createdByUserId: 'user_owner'
      }]
    });

    const keysRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/buyer-keys', 'get'),
      createMockReq({
        method: 'GET',
        path: '/v1/admin/orgs/acme/buyer-keys',
        headers: authHeaders,
        params: { slug: 'acme' }
      }),
      keysRes
    );
    expect(keysRes.statusCode).toBe(200);
    expect(keysRes.body).toEqual({
      buyerKeys: [{
        apiKeyId: 'api_key_1',
        membershipId: 'membership_member',
        userId: 'user_member',
        githubLogin: 'member-login',
        revokedAt: null
      }]
    });

    const tokensRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/tokens', 'get'),
      createMockReq({
        method: 'GET',
        path: '/v1/admin/orgs/acme/tokens',
        headers: authHeaders,
        params: { slug: 'acme' }
      }),
      tokensRes
    );
    expect(tokensRes.statusCode).toBe(200);
    expect(tokensRes.body).toEqual({
      tokens: [{
        tokenId: 'token_1',
        provider: 'anthropic',
        createdByUserId: 'user_member',
        createdByGithubLogin: 'member-login',
        fiveHourReservePercent: 15,
        sevenDayReservePercent: 25
      }]
    });

    expect(orgAccess.listOrgs).toHaveBeenCalledTimes(1);
    expect(orgAccess.findOrgBySlug).toHaveBeenCalledTimes(4);
    expect(orgAccess.listMembers).toHaveBeenCalledWith('org_1');
    expect(orgInvites.listPendingByOrg).toHaveBeenCalledWith('org_1');
    expect(orgBuyerKeys.listOrgKeysWithMembers).toHaveBeenCalledWith('org_1');
    expect(orgTokens.listOrgTokens).toHaveBeenCalledWith('org_1');
  });

  it('revokes and rotates a member buyer key through admin endpoints', async () => {
    const { deps, orgAccess, orgBuyerKeys } = createDeps();
    const router = createAdminOrgsRouter(deps);
    const authHeaders = { authorization: 'Bearer in_admin_token' };

    const revokeRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/buyer-keys/:apiKeyId/revoke', 'post'),
      createMockReq({
        method: 'POST',
        path: '/v1/admin/orgs/acme/buyer-keys/api_key_1/revoke',
        headers: authHeaders,
        params: { slug: 'acme', apiKeyId: 'api_key_1' }
      }),
      revokeRes
    );
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.body).toEqual({
      apiKeyId: 'api_key_1',
      status: 'revoked'
    });
    expect(orgBuyerKeys.revokeBuyerKeyById).toHaveBeenCalledWith('api_key_1');

    const rotateRes = createMockRes();
    await invokeHandlers(
      getRouteHandlers(router as any, '/orgs/:slug/members/:membershipId/buyer-key/rotate', 'post'),
      createMockReq({
        method: 'POST',
        path: '/v1/admin/orgs/acme/members/membership_member/buyer-key/rotate',
        headers: authHeaders,
        params: { slug: 'acme', membershipId: 'membership_member' }
      }),
      rotateRes
    );
    expect(rotateRes.statusCode).toBe(200);
    expect(rotateRes.body).toEqual({
      membershipId: 'membership_member',
      apiKeyId: 'api_key_rotated',
      plaintextKey: 'in_live_rotated'
    });
    expect(orgAccess.listMembers).toHaveBeenCalledWith('org_1');
    expect(orgBuyerKeys.rotateMembershipBuyerKey).toHaveBeenCalledWith({
      membershipId: 'membership_member',
      orgId: 'org_1',
      userId: 'user_member'
    });
  });

  it('rejects buyer keys without admin scope on every endpoint', async () => {
    const { deps, orgAccess, orgInvites, orgBuyerKeys, orgTokens } = createDeps('buyer_proxy');
    const router = createAdminOrgsRouter(deps);
    const headers = { authorization: 'Bearer in_buyer_token' };

    const cases: Array<{
      method: 'get' | 'post';
      routePath: string;
      path: string;
      params: Record<string, string>;
    }> = [
      { method: 'get', routePath: '/orgs', path: '/v1/admin/orgs', params: {} },
      { method: 'get', routePath: '/orgs/:slug/members', path: '/v1/admin/orgs/acme/members', params: { slug: 'acme' } },
      { method: 'get', routePath: '/orgs/:slug/invites', path: '/v1/admin/orgs/acme/invites', params: { slug: 'acme' } },
      { method: 'get', routePath: '/orgs/:slug/buyer-keys', path: '/v1/admin/orgs/acme/buyer-keys', params: { slug: 'acme' } },
      { method: 'get', routePath: '/orgs/:slug/tokens', path: '/v1/admin/orgs/acme/tokens', params: { slug: 'acme' } },
      { method: 'post', routePath: '/orgs/:slug/buyer-keys/:apiKeyId/revoke', path: '/v1/admin/orgs/acme/buyer-keys/api_key_1/revoke', params: { slug: 'acme', apiKeyId: 'api_key_1' } },
      { method: 'post', routePath: '/orgs/:slug/members/:membershipId/buyer-key/rotate', path: '/v1/admin/orgs/acme/members/membership_member/buyer-key/rotate', params: { slug: 'acme', membershipId: 'membership_member' } }
    ];

    for (const testCase of cases) {
      const res = createMockRes();
      await invokeHandlers(
        getRouteHandlers(router as any, testCase.routePath, testCase.method),
        createMockReq({
          method: testCase.method.toUpperCase(),
          path: testCase.path,
          headers,
          params: testCase.params
        }),
        res
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ code: 'forbidden', message: 'Invalid API key scope' });
    }

    expect(orgAccess.listOrgs).not.toHaveBeenCalled();
    expect(orgAccess.findOrgBySlug).not.toHaveBeenCalled();
    expect(orgInvites.listPendingByOrg).not.toHaveBeenCalled();
    expect(orgBuyerKeys.listOrgKeysWithMembers).not.toHaveBeenCalled();
    expect(orgBuyerKeys.revokeBuyerKeyById).not.toHaveBeenCalled();
    expect(orgBuyerKeys.rotateMembershipBuyerKey).not.toHaveBeenCalled();
    expect(orgTokens.listOrgTokens).not.toHaveBeenCalled();
  });
});
