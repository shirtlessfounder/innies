import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgGithubAuthService } from '../src/services/org/orgGithubAuthService.js';

describe('OrgGithubAuthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createFetchMock(login: string) {
    return vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_123' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login, email: null, name: 'Ship It' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ email: 'shipit@example.com', primary: true, verified: true }])
      });
  }

  function createService(input?: {
    fetchImpl?: typeof fetch;
    orgAccessRepository?: {
      upsertGithubLogin: ReturnType<typeof vi.fn>;
      findAuthResolutionBySlugAndGithubLogin: ReturnType<typeof vi.fn>;
    };
    sessionService?: {
      issueSession: ReturnType<typeof vi.fn>;
    };
  }) {
    return new OrgGithubAuthService({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://innies.example.com/v1/org/auth/github/callback',
      stateSecret: 'org-oauth-state-secret',
      identityRepository: {
        ensureUser: vi.fn().mockResolvedValue({ id: 'user_shipit', email: 'shipit@example.com' })
      } as any,
      orgAccessRepository: input?.orgAccessRepository ?? {
        upsertGithubLogin: vi.fn().mockResolvedValue(undefined),
        findAuthResolutionBySlugAndGithubLogin: vi.fn().mockResolvedValue({
          kind: 'pending_invite',
          orgId: 'org_1',
          orgSlug: 'space-cats',
          orgName: 'Space Cats',
          inviteId: 'invite_1'
        })
      },
      sessionService: input?.sessionService ?? {
        issueSession: vi.fn().mockReturnValue('signed-org-session')
      },
      now: () => new Date('2026-03-24T00:00:00Z'),
      fetchImpl: input?.fetchImpl
    });
  }

  it('round-trips the same org route through oauth state for unauthenticated org access', async () => {
    const fetchMock = createFetchMock('ShipIt');
    const orgAccessRepository = {
      upsertGithubLogin: vi.fn().mockResolvedValue(undefined),
      findAuthResolutionBySlugAndGithubLogin: vi.fn().mockResolvedValue({
        kind: 'pending_invite',
        orgId: 'org_1',
        orgSlug: 'space-cats',
        orgName: 'Space Cats',
        inviteId: 'invite_1'
      })
    };
    const service = createService({
      fetchImpl: fetchMock as typeof fetch,
      orgAccessRepository
    });

    const authorizationUrl = service.buildAuthorizationUrl({ returnTo: '/space-cats' });
    const state = new URL(authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const result = await service.finishOauthCallback({
      code: 'oauth-code',
      state: state!
    });

    expect(result.returnTo).toBe('/space-cats');
    expect(orgAccessRepository.findAuthResolutionBySlugAndGithubLogin).toHaveBeenCalledWith({
      orgSlug: 'space-cats',
      githubLogin: 'shipit'
    });
  });

  it('resolves the callback against the requested org slug instead of a fixed target org', async () => {
    const fetchMock = createFetchMock('RouteScopedUser');
    const orgAccessRepository = {
      upsertGithubLogin: vi.fn().mockResolvedValue(undefined),
      findAuthResolutionBySlugAndGithubLogin: vi.fn().mockResolvedValue({
        kind: 'active_membership',
        orgId: 'org_multi',
        orgSlug: 'second-org',
        orgName: 'Second Org',
        userId: 'user_shipit',
        membershipId: 'membership_1',
        isOwner: false
      })
    };
    const service = createService({
      fetchImpl: fetchMock as typeof fetch,
      orgAccessRepository
    });

    const state = new URL(service.buildAuthorizationUrl({
      returnTo: '/second-org'
    })).searchParams.get('state');

    const result = await service.finishOauthCallback({
      code: 'oauth-code',
      state: state!
    });

    expect(result.authResolution).toEqual({
      kind: 'active_membership',
      orgId: 'org_multi',
      orgSlug: 'second-org',
      orgName: 'Second Org',
      userId: 'user_shipit',
      membershipId: 'membership_1',
      isOwner: false
    });
    expect(orgAccessRepository.findAuthResolutionBySlugAndGithubLogin).toHaveBeenCalledWith({
      orgSlug: 'second-org',
      githubLogin: 'routescopeduser'
    });
  });

  it('persists the normalized github login before access resolution and session issuance', async () => {
    const fetchMock = createFetchMock('  MiXeDCaSeUser  ');
    const orgAccessRepository = {
      upsertGithubLogin: vi.fn().mockResolvedValue(undefined),
      findAuthResolutionBySlugAndGithubLogin: vi.fn().mockResolvedValue({
        kind: 'no_access',
        orgId: 'org_1',
        orgSlug: 'space-cats',
        orgName: 'Space Cats'
      })
    };
    const sessionService = {
      issueSession: vi.fn().mockReturnValue('signed-org-session')
    };
    const service = createService({
      fetchImpl: fetchMock as typeof fetch,
      orgAccessRepository,
      sessionService
    });

    const state = new URL(service.buildAuthorizationUrl({
      returnTo: '/space-cats'
    })).searchParams.get('state');

    await service.finishOauthCallback({
      code: 'oauth-code',
      state: state!
    });

    expect(orgAccessRepository.upsertGithubLogin).toHaveBeenCalledWith('user_shipit', 'mixedcaseuser');
    expect(orgAccessRepository.findAuthResolutionBySlugAndGithubLogin).toHaveBeenCalledWith({
      orgSlug: 'space-cats',
      githubLogin: 'mixedcaseuser'
    });
    expect(sessionService.issueSession).toHaveBeenCalledWith({
      actorUserId: 'user_shipit',
      githubLogin: 'mixedcaseuser'
    });
    expect(orgAccessRepository.upsertGithubLogin.mock.invocationCallOrder[0])
      .toBeLessThan(orgAccessRepository.findAuthResolutionBySlugAndGithubLogin.mock.invocationCallOrder[0]);
    expect(orgAccessRepository.findAuthResolutionBySlugAndGithubLogin.mock.invocationCallOrder[0])
      .toBeLessThan(sessionService.issueSession.mock.invocationCallOrder[0]);
  });
});
