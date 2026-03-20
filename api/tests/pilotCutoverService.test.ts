import { describe, expect, it, vi } from 'vitest';
import { PilotCutoverService } from '../src/services/pilot/pilotCutoverService.js';

function createService(overrides?: Partial<ConstructorParameters<typeof PilotCutoverService>[0]>) {
  const freezeRepository = {
    activateFreeze: vi.fn().mockResolvedValue(undefined),
    releaseFreeze: vi.fn().mockResolvedValue(true),
    recordFailure: vi.fn().mockResolvedValue(true)
  };

  const identityRepository = {
    ensureOrg: vi.fn().mockResolvedValue({ id: 'org_fnf', slug: 'fnf', name: 'Friends & Family' }),
    ensureUser: vi.fn().mockResolvedValue({ id: 'user_darryn', email: 'darryn@example.com', display_name: 'Darryn' }),
    ensureMembership: vi.fn().mockResolvedValue({ id: 'membership_1', org_id: 'org_fnf', user_id: 'user_darryn', role: 'buyer' }),
    reassignBuyerKeysToOrg: vi.fn().mockResolvedValue(['buyer_1']),
    reassignTokenCredentialsToOrg: vi.fn().mockResolvedValue(['cred_1'])
  };

  const fnfOwnershipRepository = {
    upsertBuyerKeyOwnership: vi.fn().mockResolvedValue({}),
    upsertTokenCredentialOwnership: vi.fn().mockResolvedValue({})
  };

  const cutoverRepository = {
    createCutoverRecord: vi.fn().mockResolvedValue({ id: 'cut_1', target_org_id: 'org_fnf' }),
    createRollbackRecord: vi.fn().mockResolvedValue({ id: 'rollback_1' })
  };

  const reserveFloorMigration = {
    migrateReserveFloors: vi.fn().mockResolvedValue(undefined)
  };

  const sql = {
    query: vi.fn(),
    transaction: vi.fn(async (run: (tx: object) => Promise<unknown>) => run({}))
  };

  const service = new PilotCutoverService({
    sql: sql as any,
    freezeRepository: freezeRepository as any,
    reserveFloorMigration,
    createIdentityRepository: vi.fn().mockReturnValue(identityRepository),
    createFnfOwnershipRepository: vi.fn().mockReturnValue(fnfOwnershipRepository),
    createPilotCutoverRepository: vi.fn().mockReturnValue(cutoverRepository),
    ...overrides
  });

  return {
    service,
    sql,
    freezeRepository,
    identityRepository,
    fnfOwnershipRepository,
    cutoverRepository,
    reserveFloorMigration
  };
}

describe('PilotCutoverService', () => {
  it('releases freezes inside the cutover transaction and passes the transaction to reserve-floor migration', async () => {
    const tx = { kind: 'cutover-transaction' };
    const callOrder: string[] = [];
    const reserveFloorMigration = {
      migrateReserveFloors: vi.fn().mockImplementation(async (input: { db?: object }) => {
        callOrder.push(input.db === tx ? 'migrate:tx' : 'migrate:other');
      })
    };
    const freezeRepository = {
      activateFreeze: vi.fn().mockResolvedValue(undefined),
      releaseFreeze: vi.fn().mockImplementation(async () => {
        callOrder.push('freeze:release');
        return true;
      }),
      recordFailure: vi.fn().mockResolvedValue(true)
    };
    const sql = {
      query: vi.fn(),
      transaction: vi.fn(async (run: (input: object) => Promise<unknown>) => {
        callOrder.push('tx:before-commit');
        const result = await run(tx);
        callOrder.push('tx:after-work');
        return result;
      })
    };

    const { service } = createService({
      sql: sql as any,
      freezeRepository: freezeRepository as any,
      reserveFloorMigration
    });

    await service.cutover({
      sourceOrgId: 'org_innies',
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      targetUserEmail: 'darryn@example.com',
      targetUserDisplayName: 'Darryn',
      targetGithubLogin: 'darryn',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1']
    });

    expect(callOrder).toContain('migrate:tx');
    expect(callOrder.lastIndexOf('freeze:release')).toBeLessThan(callOrder.indexOf('tx:after-work'));
  });

  it('cuts over buyer keys and token credentials, then releases freezes after reserve-floor migration succeeds', async () => {
    const {
      service,
      freezeRepository,
      identityRepository,
      fnfOwnershipRepository,
      cutoverRepository,
      reserveFloorMigration
    } = createService();

    const result = await service.cutover({
      sourceOrgId: 'org_innies',
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      targetUserEmail: 'darryn@example.com',
      targetUserDisplayName: 'Darryn',
      targetGithubLogin: 'darryn',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1'],
      actorUserId: 'user_admin',
      effectiveAt: new Date('2026-03-20T00:00:00Z')
    });

    expect(freezeRepository.activateFreeze).toHaveBeenCalledTimes(2);
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
    expect(identityRepository.reassignBuyerKeysToOrg).toHaveBeenCalledWith({
      apiKeyIds: ['buyer_1'],
      targetOrgId: 'org_fnf'
    });
    expect(identityRepository.reassignTokenCredentialsToOrg).toHaveBeenCalledWith({
      tokenCredentialIds: ['cred_1'],
      targetOrgId: 'org_fnf'
    });
    expect(fnfOwnershipRepository.upsertBuyerKeyOwnership).toHaveBeenCalledWith({
      apiKeyId: 'buyer_1',
      ownerOrgId: 'org_fnf',
      ownerUserId: 'user_darryn'
    });
    expect(fnfOwnershipRepository.upsertTokenCredentialOwnership).toHaveBeenCalledWith({
      tokenCredentialId: 'cred_1',
      ownerOrgId: 'org_fnf',
      capacityOwnerUserId: 'user_darryn'
    });
    expect(cutoverRepository.createCutoverRecord).toHaveBeenCalledWith(expect.objectContaining({
      sourceOrgId: 'org_innies',
      targetOrgId: 'org_fnf',
      buyerKeyOwnershipSwapped: true,
      providerCredentialOwnershipSwapped: true,
      reserveFloorMigrationCompleted: true
    }));
    expect(reserveFloorMigration.migrateReserveFloors).toHaveBeenCalledWith({
      db: expect.any(Object),
      fromOrgId: 'org_innies',
      toOrgId: 'org_fnf',
      targetUserId: 'user_darryn',
      cutoverId: 'cut_1',
      actorUserId: 'user_admin'
    });
    expect(freezeRepository.releaseFreeze).toHaveBeenCalledTimes(2);
    expect(result.cutoverRecord.id).toBe('cut_1');
  });

  it('records failure details and keeps admissions fail-closed when reserve-floor migration fails', async () => {
    const reserveFloorMigration = {
      migrateReserveFloors: vi.fn().mockRejectedValue(new Error('reserve floor migration failed'))
    };
    const {
      service,
      freezeRepository
    } = createService({ reserveFloorMigration });

    await expect(service.cutover({
      sourceOrgId: 'org_innies',
      targetOrgSlug: 'fnf',
      targetOrgName: 'Friends & Family',
      targetUserEmail: 'darryn@example.com',
      targetUserDisplayName: 'Darryn',
      targetGithubLogin: 'darryn',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1']
    })).rejects.toThrow('reserve floor migration failed');

    expect(freezeRepository.recordFailure).toHaveBeenCalledTimes(2);
    expect(freezeRepository.releaseFreeze).not.toHaveBeenCalled();
  });

  it('rolls ownership back and releases freezes after writing the rollback record', async () => {
    const {
      service,
      freezeRepository,
      identityRepository,
      fnfOwnershipRepository,
      cutoverRepository,
      reserveFloorMigration
    } = createService();

    const result = await service.rollback({
      sourceCutoverId: 'cut_1',
      targetOrgId: 'org_innies',
      buyerKeyIds: ['buyer_1'],
      tokenCredentialIds: ['cred_1'],
      actorUserId: 'user_admin',
      effectiveAt: new Date('2026-03-20T01:00:00Z')
    });

    expect(identityRepository.reassignBuyerKeysToOrg).toHaveBeenCalledWith({
      apiKeyIds: ['buyer_1'],
      targetOrgId: 'org_innies'
    });
    expect(identityRepository.reassignTokenCredentialsToOrg).toHaveBeenCalledWith({
      tokenCredentialIds: ['cred_1'],
      targetOrgId: 'org_innies'
    });
    expect(fnfOwnershipRepository.upsertBuyerKeyOwnership).toHaveBeenCalledWith({
      apiKeyId: 'buyer_1',
      ownerOrgId: 'org_innies',
      ownerUserId: null
    });
    expect(fnfOwnershipRepository.upsertTokenCredentialOwnership).toHaveBeenCalledWith({
      tokenCredentialId: 'cred_1',
      ownerOrgId: 'org_innies',
      capacityOwnerUserId: null
    });
    expect(cutoverRepository.createRollbackRecord).toHaveBeenCalledWith({
      sourceCutoverId: 'cut_1',
      effectiveAt: new Date('2026-03-20T01:00:00Z'),
      revertedBuyerKeyTargetOrgId: 'org_innies',
      revertedProviderCredentialTargetOrgId: 'org_innies',
      createdByUserId: 'user_admin'
    });
    expect(freezeRepository.releaseFreeze).toHaveBeenCalledTimes(2);
    expect(reserveFloorMigration.migrateReserveFloors).not.toHaveBeenCalled();
    expect(result.rollbackRecord.id).toBe('rollback_1');
  });
});
