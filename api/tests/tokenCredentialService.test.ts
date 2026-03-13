import { describe, expect, it, vi } from 'vitest';
import { TokenCredentialService } from '../src/services/tokenCredentialService.js';
import { AppError } from '../src/utils/errors.js';

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

  it('maps unrotatable previousCredentialId errors into invalid_request app errors', async () => {
    const repo = {
      rotate: vi.fn(async () => {
        throw new Error('Credential cred_maxed_old not found or not rotatable for org/provider');
      })
    };
    const service = new TokenCredentialService(repo as any, { createEvent: vi.fn() } as any);

    await expect(service.rotate({
      orgId: 'org_1',
      provider: 'anthropic',
      authScheme: 'bearer',
      accessToken: 'c',
      refreshToken: 'd',
      expiresAt: new Date('2026-03-03T00:00:00Z'),
      previousCredentialId: 'cred_maxed_old'
    })).rejects.toMatchObject<AppError>({
      code: 'invalid_request',
      status: 400,
      message: 'Credential cred_maxed_old not found or not rotatable for org/provider'
    });
  });

  it('writes an audit event for Claude contribution-cap updates', async () => {
    const repo = {
      getById: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'anthropic'
      })),
      updateContributionCap: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'anthropic',
        fiveHourReservePercent: 25,
        sevenDayReservePercent: 10
      }))
    };
    const createEvent = vi.fn(async () => ({ id: 'audit_1' }));
    const service = new TokenCredentialService(repo as any, { createEvent } as any);

    const updated = await service.updateContributionCap('cred_1', {
      fiveHourReservePercent: 25,
      sevenDayReservePercent: 10
    });

    expect(updated).toEqual({
      id: 'cred_1',
      orgId: 'org_1',
      provider: 'anthropic',
      fiveHourReservePercent: 25,
      sevenDayReservePercent: 10
    });
    expect(repo.getById).toHaveBeenCalledWith('cred_1');
    expect(repo.updateContributionCap).toHaveBeenCalledWith('cred_1', {
      fiveHourReservePercent: 25,
      sevenDayReservePercent: 10
    });
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'token_credential.update_contribution_cap',
      targetId: 'cred_1',
      orgId: 'org_1'
    }));
  });

  it('rejects contribution-cap updates for non-Claude credentials', async () => {
    const repo = {
      getById: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'openai'
      })),
      updateContributionCap: vi.fn()
    };
    const createEvent = vi.fn();
    const service = new TokenCredentialService(repo as any, { createEvent } as any);

    await expect(service.updateContributionCap('cred_1', {
      fiveHourReservePercent: 25
    })).rejects.toMatchObject<AppError>({
      code: 'invalid_request',
      status: 400,
      message: 'Contribution caps are only supported for Claude token credentials'
    });
    expect(repo.updateContributionCap).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
