import { describe, expect, it } from 'vitest';
import { PilotSessionService } from '../src/services/pilot/pilotSessionService.js';

describe('PilotSessionService', () => {
  it('signs and verifies Darryn self-session tokens', () => {
    const service = new PilotSessionService({
      secret: 'pilot-session-secret',
      now: () => new Date('2026-03-20T00:00:00Z'),
      ttlSeconds: 3600
    });

    const token = service.issueSession({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      actorApiKeyId: null,
      actorOrgId: 'org_fnf',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com',
      impersonatedUserId: null
    });

    expect(service.readSession(token)).toEqual(expect.objectContaining({
      sessionKind: 'darryn_self',
      actorUserId: 'user_darryn',
      effectiveOrgId: 'org_fnf',
      githubLogin: 'darryn',
      userEmail: 'darryn@example.com'
    }));
  });

  it('rejects tampered session tokens', () => {
    const service = new PilotSessionService({
      secret: 'pilot-session-secret',
      now: () => new Date('2026-03-20T00:00:00Z'),
      ttlSeconds: 3600
    });
    const token = service.issueSession({
      sessionKind: 'admin_impersonation',
      actorUserId: null,
      actorApiKeyId: 'admin_key_1',
      actorOrgId: 'org_innies',
      effectiveOrgId: 'org_fnf',
      effectiveOrgSlug: 'fnf',
      effectiveOrgName: 'Friends & Family',
      githubLogin: null,
      userEmail: null,
      impersonatedUserId: 'user_darryn'
    });

    expect(service.readSession(`${token}tampered`)).toBeNull();
  });

  it('prefers bearer tokens over cookies when reading request session tokens', () => {
    const service = new PilotSessionService({
      secret: 'pilot-session-secret',
      now: () => new Date('2026-03-20T00:00:00Z'),
      ttlSeconds: 3600
    });

    expect(service.readTokenFromRequest({
      header(name: string) {
        if (name.toLowerCase() === 'authorization') {
          return 'Bearer bearer-token';
        }
        if (name.toLowerCase() === 'cookie') {
          return 'other=1; innies_pilot_session=cookie-token';
        }
        return undefined;
      }
    } as any)).toBe('bearer-token');
  });
});
