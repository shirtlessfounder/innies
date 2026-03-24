import { describe, expect, it } from 'vitest';
import { OrgSessionService } from '../src/services/org/orgSessionService.js';

describe('OrgSessionService', () => {
  it('signs and verifies org web sessions', () => {
    const service = new OrgSessionService({
      secret: 'org-session-secret',
      now: () => new Date('2026-03-24T00:00:00Z'),
      ttlSeconds: 3600
    });

    const token = service.issueSession({
      actorUserId: 'user_1',
      githubLogin: 'shirtlessfounder'
    });

    expect(service.readSession(token)).toEqual({
      actorUserId: 'user_1',
      githubLogin: 'shirtlessfounder',
      issuedAt: '2026-03-24T00:00:00.000Z',
      expiresAt: '2026-03-24T01:00:00.000Z'
    });
  });

  it('rejects tampered org session tokens', () => {
    const service = new OrgSessionService({
      secret: 'org-session-secret',
      now: () => new Date('2026-03-24T00:00:00Z'),
      ttlSeconds: 3600
    });

    const token = service.issueSession({
      actorUserId: 'user_1',
      githubLogin: 'shirtlessfounder'
    });

    expect(service.readSession(`${token}tampered`)).toBeNull();
  });

  it('rejects expired org session tokens', () => {
    const service = new OrgSessionService({
      secret: 'org-session-secret',
      now: () => new Date('2026-03-24T02:00:00Z'),
      ttlSeconds: 3600
    });

    const expiredToken = new OrgSessionService({
      secret: 'org-session-secret',
      now: () => new Date('2026-03-24T00:00:00Z'),
      ttlSeconds: 3600
    }).issueSession({
      actorUserId: 'user_1',
      githubLogin: 'shirtlessfounder'
    });

    expect(service.readSession(expiredToken)).toBeNull();
  });
});
