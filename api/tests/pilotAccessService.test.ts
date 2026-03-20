import { describe, expect, it, vi } from 'vitest';
import { PilotAccessService } from '../src/services/pilotAccessService.js';

function createService(overrides: Partial<ConstructorParameters<typeof PilotAccessService>[0]> = {}) {
  const deps = {
    apiKeys: {
      getById: vi.fn(),
      reassignOrg: vi.fn()
    },
    tokenCredentials: {
      getById: vi.fn(),
      reassignOrg: vi.fn()
    },
    fnfOwnership: {
      upsertBuyerKeyOwnership: vi.fn(),
      upsertTokenCredentialOwnership: vi.fn()
    },
    cutoverRecords: {
      createCutoverRecord: vi.fn(),
      createRollbackRecord: vi.fn(),
      getLatestCommittedCutover: vi.fn()
    },
    identities: {
      ensureOrg: vi.fn(),
      ensureUser: vi.fn(),
      ensureMembership: vi.fn(),
      upsertGithubIdentity: vi.fn()
    },
    freezes: {
      createFreeze: vi.fn(),
      releaseFreeze: vi.fn()
    },
    reserveFloors: {
      migrateReserveFloors: vi.fn()
    },
    createId: vi.fn(() => 'cutover_1'),
    ...overrides
  };

  return {
    service: new PilotAccessService(deps as any),
    deps
  };
}

describe('PilotAccessService', () => {
  it('commits cutover only after migration, reserve-floor handshake, and freeze release', async () => {
    const { service, deps } = createService();
    deps.apiKeys.getById.mockResolvedValue({
      id: 'buyer_1',
      org_id: 'org_innies',
      scope: 'buyer_proxy'
    });
    deps.identities.ensureOrg.mockResolvedValue({ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' });
    deps.identities.ensureUser.mockResolvedValue({ id: 'user_darryn', email: 'darryn@example.com' });
    deps.identities.ensureMembership.mockResolvedValue({ id: 'membership_1' });
    deps.freezes.createFreeze.mockResolvedValue({ id: 'freeze_1' });
    deps.tokenCredentials.getById
      .mockResolvedValueOnce({ id: 'cred_1', orgId: 'org_innies' })
      .mockResolvedValueOnce({ id: 'cred_2', orgId: 'org_innies' });
    deps.cutoverRecords.createCutoverRecord.mockResolvedValue({
      id: 'cutover_1',
      source_org_id: 'org_innies',
      target_org_id: 'org_fnf'
    });
    deps.freezes.releaseFreeze.mockResolvedValue(true);

    const result = await service.performCutover({
      buyerKeyId: 'buyer_1',
      tokenCredentialIds: ['cred_1', 'cred_2'],
      darrynEmail: 'darryn@example.com',
      darrynDisplayName: 'Darryn',
      darrynGithubLogin: 'darryn'
    });

    expect(result.cutoverId).toBe('cutover_1');
    expect(deps.identities.ensureOrg).toHaveBeenCalledWith({
      slug: 'fnf',
      name: 'Friends & Family'
    });
    expect(deps.apiKeys.reassignOrg).toHaveBeenCalledWith('buyer_1', 'org_fnf');
    expect(deps.tokenCredentials.reassignOrg).toHaveBeenNthCalledWith(1, 'cred_1', 'org_fnf');
    expect(deps.tokenCredentials.reassignOrg).toHaveBeenNthCalledWith(2, 'cred_2', 'org_fnf');
    expect(deps.reserveFloors.migrateReserveFloors).toHaveBeenCalledWith('org_innies', 'org_fnf', 'cutover_1');
    expect(deps.cutoverRecords.createCutoverRecord).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cutover_1',
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      buyerKeyOwnershipSwapped: true,
      providerCredentialOwnershipSwapped: true,
      reserveFloorMigrationCompleted: true
    }));
    expect(deps.reserveFloors.migrateReserveFloors.mock.invocationCallOrder[0]).toBeLessThan(
      deps.cutoverRecords.createCutoverRecord.mock.invocationCallOrder[0]
    );
    expect(deps.freezes.releaseFreeze).toHaveBeenCalledWith({
      freezeId: 'freeze_1',
      releaseReason: 'cutover_committed'
    });
  });

  it('fails closed when the reserve-floor handshake fails and leaves the freeze active', async () => {
    const { service, deps } = createService();
    deps.apiKeys.getById.mockResolvedValue({
      id: 'buyer_1',
      org_id: 'org_innies',
      scope: 'buyer_proxy'
    });
    deps.identities.ensureOrg.mockResolvedValue({ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' });
    deps.identities.ensureUser.mockResolvedValue({ id: 'user_darryn', email: 'darryn@example.com' });
    deps.identities.ensureMembership.mockResolvedValue({ id: 'membership_1' });
    deps.freezes.createFreeze.mockResolvedValue({ id: 'freeze_1' });
    deps.tokenCredentials.getById.mockResolvedValue({ id: 'cred_1', orgId: 'org_innies' });
    deps.reserveFloors.migrateReserveFloors.mockRejectedValue(new Error('routing seam unavailable'));

    await expect(service.performCutover({
      buyerKeyId: 'buyer_1',
      tokenCredentialIds: ['cred_1'],
      darrynEmail: 'darryn@example.com'
    })).rejects.toThrow('routing seam unavailable');

    expect(deps.apiKeys.reassignOrg).toHaveBeenCalledWith('buyer_1', 'org_fnf');
    expect(deps.cutoverRecords.createCutoverRecord).not.toHaveBeenCalled();
    expect(deps.freezes.releaseFreeze).not.toHaveBeenCalled();
  });

  it('rolls future admissions back to the original org and writes a rollback marker', async () => {
    const { service, deps } = createService();
    deps.apiKeys.getById.mockResolvedValue({
      id: 'buyer_1',
      org_id: 'org_fnf',
      scope: 'buyer_proxy'
    });
    deps.tokenCredentials.getById.mockResolvedValue({ id: 'cred_1', orgId: 'org_fnf' });
    deps.cutoverRecords.getLatestCommittedCutover.mockResolvedValue({
      id: 'cutover_1',
      source_org_id: 'org_innies',
      target_org_id: 'org_fnf'
    });
    deps.freezes.createFreeze.mockResolvedValue({ id: 'freeze_rollback_1' });
    deps.cutoverRecords.createRollbackRecord.mockResolvedValue({
      id: 'rollback_1',
      source_cutover_id: 'cutover_1'
    });
    deps.freezes.releaseFreeze.mockResolvedValue(true);

    const result = await service.performRollback({
      buyerKeyId: 'buyer_1',
      tokenCredentialIds: ['cred_1']
    });

    expect(result.rollbackId).toBe('rollback_1');
    expect(deps.apiKeys.reassignOrg).toHaveBeenCalledWith('buyer_1', 'org_innies');
    expect(deps.tokenCredentials.reassignOrg).toHaveBeenCalledWith('cred_1', 'org_innies');
    expect(deps.cutoverRecords.createRollbackRecord).toHaveBeenCalledWith(expect.objectContaining({
      sourceCutoverId: 'cutover_1',
      revertedBuyerKeyTargetOrgId: 'org_innies',
      revertedProviderCredentialTargetOrgId: 'org_innies'
    }));
    expect(deps.freezes.releaseFreeze).toHaveBeenCalledWith({
      freezeId: 'freeze_rollback_1',
      releaseReason: 'rollback_committed'
    });
  });
});
