import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/utils/errors.js';
import { PilotSessionService } from '../src/services/pilotSessionService.js';

function createService() {
  const identities = {
    ensureOrg: vi.fn().mockResolvedValue({ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' }),
    findOrgBySlug: vi.fn().mockResolvedValue({ id: 'org_innies', slug: 'innies', name: 'Innies' }),
    ensureUser: vi.fn().mockResolvedValue({ id: 'user_darryn', email: 'darryn@example.com', display_name: 'Darryn' }),
    ensureMembership: vi.fn().mockResolvedValue({ id: 'membership_1' }),
    upsertGithubIdentity: vi.fn().mockResolvedValue({ user_id: 'user_darryn', github_login: 'darryn' }),
    findGithubIdentityByLogin: vi.fn().mockResolvedValue({
      user_id: 'user_darryn',
      github_user_id: '12345',
      github_login: 'darryn',
      github_email: 'darryn@example.com'
    })
  };
  const github = {
    exchangeCodeForViewer: vi.fn()
  };

  const service = new PilotSessionService({
    identities: identities as any,
    github,
    sessionSecret: 'pilot-test-secret',
    darrynGithubAllowlist: ['darryn'],
    adminGithubAllowlist: ['adminuser']
  });

  return { service, identities, github };
}

describe('PilotSessionService', () => {
  it('creates a Darryn self-context session from an allowlisted GitHub callback', async () => {
    const { service, identities, github } = createService();
    github.exchangeCodeForViewer.mockResolvedValue({
      githubUserId: '12345',
      githubLogin: 'darryn',
      email: 'darryn@example.com',
      displayName: 'Darryn'
    });

    const result = await service.createSessionFromGithubCallback({
      mode: 'darryn',
      code: 'oauth_code'
    });

    const session = service.readFromToken(result.token);

    expect(result.session.contextKind).toBe('darryn_self');
    expect(session.active.orgId).toBe('org_fnf');
    expect(identities.ensureOrg).toHaveBeenCalledWith({
      slug: 'fnf',
      name: 'Friends & Family'
    });
    expect(identities.upsertGithubIdentity).toHaveBeenCalledWith({
      userId: 'user_darryn',
      githubUserId: '12345',
      githubLogin: 'darryn',
      githubEmail: 'darryn@example.com'
    });
  });

  it('creates an admin self-context session from an admin allowlisted GitHub callback', async () => {
    const { service, identities, github } = createService();
    identities.ensureUser.mockResolvedValueOnce({
      id: 'user_admin',
      email: 'admin@example.com',
      display_name: 'Admin User'
    });
    github.exchangeCodeForViewer.mockResolvedValue({
      githubUserId: '777',
      githubLogin: 'adminuser',
      email: 'admin@example.com',
      displayName: 'Admin User'
    });

    const result = await service.createSessionFromGithubCallback({
      mode: 'admin',
      code: 'oauth_code'
    });

    const session = service.readFromToken(result.token);

    expect(result.session.contextKind).toBe('admin_self');
    expect(session.active.orgId).toBe('org_innies');
    expect(identities.findOrgBySlug).toHaveBeenCalledWith('innies');
    expect(identities.ensureMembership).toHaveBeenCalledWith({
      orgId: 'org_innies',
      userId: 'user_admin',
      role: 'admin'
    });
  });

  it('creates an admin impersonation context over Darryn', async () => {
    const { service } = createService();
    const adminToken = service.issueToken({
      contextKind: 'admin_self',
      actor: {
        userId: 'user_admin',
        githubLogin: 'adminuser',
        role: 'admin'
      },
      active: {
        userId: 'user_admin',
        githubLogin: 'adminuser',
        orgId: 'org_innies'
      }
    });

    const result = await service.impersonateByGithubLogin(adminToken, 'darryn');
    const session = service.readFromToken(result.token);

    expect(result.session.contextKind).toBe('admin_impersonation');
    expect(session.actor.githubLogin).toBe('adminuser');
    expect(session.active.githubLogin).toBe('darryn');
    expect(session.active.orgId).toBe('org_fnf');
  });

  it('clears an admin impersonation back to admin self-context', async () => {
    const { service } = createService();
    const impersonatedToken = service.issueToken({
      contextKind: 'admin_impersonation',
      actor: {
        userId: 'user_admin',
        githubLogin: 'adminuser',
        role: 'admin'
      },
      active: {
        userId: 'user_darryn',
        githubLogin: 'darryn',
        orgId: 'org_fnf'
      }
    });

    const result = await service.clearImpersonation(impersonatedToken);
    const session = service.readFromToken(result.token);

    expect(result.session.contextKind).toBe('admin_self');
    expect(session.active.githubLogin).toBe('adminuser');
    expect(session.active.orgId).toBe('org_innies');
  });

  it('rejects a non-allowlisted Darryn GitHub login', async () => {
    const { service, github } = createService();
    github.exchangeCodeForViewer.mockResolvedValue({
      githubUserId: '999',
      githubLogin: 'not-darryn',
      email: 'else@example.com',
      displayName: 'Else'
    });

    await expect(service.createSessionFromGithubCallback({
      mode: 'darryn',
      code: 'oauth_code'
    })).rejects.toMatchObject<AppError>({
      code: 'forbidden',
      status: 403
    });
  });
});
