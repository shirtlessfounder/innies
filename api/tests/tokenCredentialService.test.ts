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

  it('updates a token credential debug label and writes an audit event', async () => {
    const repo = {
      getById: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'openai',
        debugLabel: 'codex-main-1',
        status: 'active'
      })),
      updateDebugLabel: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'openai',
        debugLabel: 'codex-main-2'
      }))
    };
    const createEvent = vi.fn(async () => ({ id: 'audit_1' }));
    const service = new TokenCredentialService(repo as any, { createEvent } as any);

    const updated = await service.updateDebugLabel('cred_1', 'codex-main-2');

    expect(updated).toEqual({
      id: 'cred_1',
      orgId: 'org_1',
      provider: 'openai',
      debugLabel: 'codex-main-2',
      changed: true
    });
    expect(repo.getById).toHaveBeenCalledWith('cred_1');
    expect(repo.updateDebugLabel).toHaveBeenCalledWith('cred_1', 'codex-main-2');
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'token_credential.update_debug_label',
      targetId: 'cred_1',
      orgId: 'org_1',
      metadata: expect.objectContaining({
        previousDebugLabel: 'codex-main-1',
        debugLabel: 'codex-main-2'
      })
    }));
  });

  it('preserves label no-ops and rejects revoked credentials', async () => {
    const activeRepo = {
      getById: vi.fn(async () => ({
        id: 'cred_1',
        orgId: 'org_1',
        provider: 'anthropic',
        debugLabel: 'oauth-main-1',
        status: 'active'
      })),
      updateDebugLabel: vi.fn()
    };
    const activeCreateEvent = vi.fn();
    const activeService = new TokenCredentialService(activeRepo as any, { createEvent: activeCreateEvent } as any);

    await expect(activeService.updateDebugLabel('cred_1', 'oauth-main-1')).resolves.toEqual({
      id: 'cred_1',
      orgId: 'org_1',
      provider: 'anthropic',
      debugLabel: 'oauth-main-1',
      changed: false
    });
    expect(activeRepo.updateDebugLabel).not.toHaveBeenCalled();
    expect(activeCreateEvent).not.toHaveBeenCalled();

    const revokedRepo = {
      getById: vi.fn(async () => ({
        id: 'cred_revoked',
        orgId: 'org_1',
        provider: 'anthropic',
        debugLabel: 'old-label',
        status: 'revoked'
      })),
      updateDebugLabel: vi.fn()
    };
    const revokedCreateEvent = vi.fn();
    const revokedService = new TokenCredentialService(revokedRepo as any, { createEvent: revokedCreateEvent } as any);

    await expect(revokedService.updateDebugLabel('cred_revoked', 'new-label')).resolves.toBeNull();
    expect(revokedRepo.updateDebugLabel).not.toHaveBeenCalled();
    expect(revokedCreateEvent).not.toHaveBeenCalled();
  });

  it('writes audit events for pause and unpause', async () => {
    const repo = {
      getById: vi.fn(async (id: string) => ({
        id,
        orgId: 'org_1',
        provider: 'anthropic',
        debugLabel: 'main-1',
        status: id === 'cred_pause' ? 'active' : 'paused',
        expiresAt: new Date('2026-04-20T00:00:00Z'),
      })),
      pause: vi.fn(async () => true),
      unpause: vi.fn(async () => true),
    };
    const createEvent = vi.fn(async () => ({ id: 'audit_1' }));
    const service = new TokenCredentialService(repo as any, { createEvent } as any);

    const paused = await service.pause('cred_pause');
    const unpaused = await service.unpause('cred_unpause');

    expect(paused).toEqual({
      id: 'cred_pause',
      orgId: 'org_1',
      provider: 'anthropic',
      debugLabel: 'main-1',
      status: 'paused',
      changed: true,
    });
    expect(unpaused).toEqual({
      id: 'cred_unpause',
      orgId: 'org_1',
      provider: 'anthropic',
      debugLabel: 'main-1',
      status: 'active',
      changed: true,
    });
    expect(repo.pause).toHaveBeenCalledWith('cred_pause');
    expect(repo.unpause).toHaveBeenCalledWith('cred_unpause');
    expect(createEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: 'token_credential.pause',
      targetId: 'cred_pause',
      orgId: 'org_1',
    }));
    expect(createEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'token_credential.unpause',
      targetId: 'cred_unpause',
      orgId: 'org_1',
    }));
  });

  it('rejects unpause for non-paused or expired credentials', async () => {
    const createEvent = vi.fn();
    const service = new TokenCredentialService({
      getById: vi.fn(async (id: string) => {
        if (id === 'cred_maxed') {
          return {
            id,
            orgId: 'org_1',
            provider: 'anthropic',
            debugLabel: 'main-1',
            status: 'maxed',
            expiresAt: new Date('2026-04-20T00:00:00Z'),
          };
        }
        return {
          id,
          orgId: 'org_1',
          provider: 'anthropic',
          debugLabel: 'main-1',
          status: 'paused',
          expiresAt: new Date('2026-03-01T00:00:00Z'),
        };
      }),
      unpause: vi.fn(),
    } as any, { createEvent } as any);

    await expect(service.unpause('cred_maxed')).rejects.toMatchObject<AppError>({
      code: 'invalid_request',
      status: 409,
      message: 'Only paused token credentials can be unpaused',
    });
    await expect(service.unpause('cred_expired')).rejects.toMatchObject<AppError>({
      code: 'invalid_request',
      status: 409,
      message: 'Token credential is expired and cannot be unpaused',
    });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
