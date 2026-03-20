import { afterEach, describe, expect, it, vi } from 'vitest';
import { PilotGithubAuthService } from '../src/services/pilot/pilotGithubAuthService.js';

describe('PilotGithubAuthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exchanges the GitHub callback, enforces the allowlist, and issues a Darryn self-session', async () => {
    const identityRepository = {
      ensureOrg: vi.fn().mockResolvedValue({ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' }),
      ensureUser: vi.fn().mockResolvedValue({ id: 'user_darryn', email: 'darryn@example.com' }),
      ensureMembership: vi.fn().mockResolvedValue({ id: 'membership_1' })
    };
    const sessionService = {
      issueSession: vi.fn().mockReturnValue('signed-session-token')
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_123' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'darryn', email: null, name: 'Darryn' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ email: 'darryn@example.com', primary: true, verified: true }])
      });

    vi.stubGlobal('fetch', fetchMock);

    const service = new PilotGithubAuthService({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://innies.example.com/v1/pilot/auth/github/callback',
      allowlistedLogins: ['darryn'],
      allowlistedEmails: [],
      identityRepository: identityRepository as any,
      sessionService: sessionService as any,
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      stateSecret: 'pilot-oauth-state-secret',
      now: () => new Date('2026-03-20T00:00:00Z')
    });

    const state = service.createOauthState({ returnTo: '/pilot' });
    const result = await service.finishOauthCallback({
      code: 'oauth-code',
      state
    });

    expect(identityRepository.ensureOrg).toHaveBeenCalledWith({
      slug: 'fnf',
      name: 'Friends & Family'
    });
    expect(identityRepository.ensureUser).toHaveBeenCalledWith({
      email: 'darryn@example.com',
      displayName: 'Darryn'
    });
    expect(identityRepository.ensureMembership).toHaveBeenCalledWith({
      orgId: 'org_fnf',
      userId: 'user_darryn',
      role: 'buyer'
    });
    expect(sessionService.issueSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      effectiveOrgId: 'org_fnf',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com'
    }));
    expect(result).toEqual(expect.objectContaining({
      sessionToken: 'signed-session-token',
      returnTo: '/pilot'
    }));
  });

  it('rejects GitHub users that are not on the Darryn allowlist', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_123' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'someone-else', email: null, name: 'Someone Else' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ email: 'else@example.com', primary: true, verified: true }])
      });

    vi.stubGlobal('fetch', fetchMock);

    const service = new PilotGithubAuthService({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://innies.example.com/v1/pilot/auth/github/callback',
      allowlistedLogins: ['darryn'],
      allowlistedEmails: ['darryn@example.com'],
      identityRepository: {
        ensureOrg: vi.fn(),
        ensureUser: vi.fn(),
        ensureMembership: vi.fn()
      } as any,
      sessionService: {
        issueSession: vi.fn()
      } as any,
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      stateSecret: 'pilot-oauth-state-secret',
      now: () => new Date('2026-03-20T00:00:00Z')
    });

    const state = service.createOauthState({ returnTo: '/pilot' });

    await expect(service.finishOauthCallback({
      code: 'oauth-code',
      state
    })).rejects.toThrow('GitHub user is not allowlisted for the pilot');
  });

  it('does not treat an unverified user.email fallback as an email-allowlist match', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_123' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'someone-else', email: 'darryn@example.com', name: 'Someone Else' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ email: 'darryn@example.com', primary: true, verified: false }])
      });

    vi.stubGlobal('fetch', fetchMock);

    const service = new PilotGithubAuthService({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://innies.example.com/v1/pilot/auth/github/callback',
      allowlistedLogins: [],
      allowlistedEmails: ['darryn@example.com'],
      identityRepository: {
        ensureOrg: vi.fn(),
        ensureUser: vi.fn(),
        ensureMembership: vi.fn()
      } as any,
      sessionService: {
        issueSession: vi.fn()
      } as any,
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      stateSecret: 'pilot-oauth-state-secret',
      now: () => new Date('2026-03-20T00:00:00Z')
    });

    const state = service.createOauthState({ returnTo: '/pilot' });

    await expect(service.finishOauthCallback({
      code: 'oauth-code',
      state
    })).rejects.toThrow('GitHub user is not allowlisted for the pilot');
  });

  it('rejects login-allowlisted users that do not have a verified GitHub email for provisioning', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'gho_123' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: 'darryn', email: 'darryn@example.com', name: 'Darryn' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{ email: 'darryn@example.com', primary: true, verified: false }])
      });

    vi.stubGlobal('fetch', fetchMock);

    const service = new PilotGithubAuthService({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://innies.example.com/v1/pilot/auth/github/callback',
      allowlistedLogins: ['darryn'],
      allowlistedEmails: [],
      identityRepository: {
        ensureOrg: vi.fn(),
        ensureUser: vi.fn(),
        ensureMembership: vi.fn()
      } as any,
      sessionService: {
        issueSession: vi.fn()
      } as any,
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      stateSecret: 'pilot-oauth-state-secret',
      now: () => new Date('2026-03-20T00:00:00Z')
    });

    const state = service.createOauthState({ returnTo: '/pilot' });

    await expect(service.finishOauthCallback({
      code: 'oauth-code',
      state
    })).rejects.toThrow('GitHub user does not have a verified email for the pilot');
  });
});
