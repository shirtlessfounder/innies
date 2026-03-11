import { describe, expect, it, vi } from 'vitest';
import { TokenCredentialService } from '../src/services/tokenCredentialService.js';

describe('tokenCredentialService', () => {
  it('writes audit events for create, rotate, revoke', async () => {
    const repo = {
      create: vi.fn(async () => ({ id: 'cred_1', rotationVersion: 1 })),
      rotate: vi.fn(async () => ({ id: 'cred_2', rotationVersion: 2, previousId: 'cred_1' })),
      revoke: vi.fn(async () => true)
    };
    const createEvent = vi.fn(async () => ({ id: 'audit_1' }));
    const auditLogs = { createEvent };
    const service = new TokenCredentialService(repo as any, auditLogs as any);

    await service.create({
      orgId: 'org_1',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'a',
      refreshToken: 'b',
      expiresAt: new Date('2026-03-02T00:00:00Z')
    });
    await service.rotate({
      orgId: 'org_1',
      provider: 'anthropic',
      authScheme: 'x_api_key',
      accessToken: 'c',
      refreshToken: 'd',
      expiresAt: new Date('2026-03-03T00:00:00Z')
    });
    await service.revoke('cred_2', 'org_1');

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.rotate).toHaveBeenCalledTimes(1);
    expect(repo.revoke).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledTimes(3);
    expect(createEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'token_credential.create' }));
    expect(createEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'token_credential.rotate' }));
    expect(createEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({ action: 'token_credential.revoke' }));
  });
});
