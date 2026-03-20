import type { SqlClient } from '../../repos/sqlClient.js';
import { FnfOwnershipRepository } from '../../repos/fnfOwnershipRepository.js';
import { PilotAdmissionFreezeRepository, type FreezeResourceType } from '../../repos/pilotAdmissionFreezeRepository.js';
import { PilotIdentityRepository } from '../../repos/pilotIdentityRepository.js';
import { PilotCutoverRepository } from '../../repos/pilotCutoverRepository.js';

type IdentityRepositoryLike = Pick<
  PilotIdentityRepository,
  'ensureOrg' | 'ensureUser' | 'ensureMembership' | 'reassignBuyerKeysToOrg' | 'reassignTokenCredentialsToOrg'
>;

type FnfOwnershipRepositoryLike = Pick<
  FnfOwnershipRepository,
  'upsertBuyerKeyOwnership' | 'upsertTokenCredentialOwnership'
>;

type PilotCutoverRepositoryLike = Pick<
  PilotCutoverRepository,
  'createCutoverRecord' | 'createRollbackRecord'
>;

type PilotAdmissionFreezeRepositoryLike = Pick<
  PilotAdmissionFreezeRepository,
  'activateFreeze' | 'releaseFreeze' | 'recordFailure'
>;

type ReserveFloorMigrationAdapter = {
  migrateReserveFloors(input: {
    db: object;
    fromOrgId: string;
    toOrgId: string;
    targetUserId: string;
    cutoverId: string;
    actorUserId: string | null;
  }): Promise<void>;
};

type FreezeTarget = {
  resourceType: FreezeResourceType;
  resourceId: string;
};

export class PilotCutoverService {
  private readonly freezeRepository: PilotAdmissionFreezeRepositoryLike;
  private readonly reserveFloorMigration: ReserveFloorMigrationAdapter;
  private readonly createIdentityRepository: (db: object) => IdentityRepositoryLike;
  private readonly createFnfOwnershipRepository: (db: object) => FnfOwnershipRepositoryLike;
  private readonly createPilotCutoverRepository: (db: object) => PilotCutoverRepositoryLike;

  constructor(input: {
    sql: SqlClient;
    freezeRepository?: PilotAdmissionFreezeRepositoryLike;
    reserveFloorMigration: ReserveFloorMigrationAdapter;
    createIdentityRepository?: (db: object) => IdentityRepositoryLike;
    createFnfOwnershipRepository?: (db: object) => FnfOwnershipRepositoryLike;
    createPilotCutoverRepository?: (db: object) => PilotCutoverRepositoryLike;
  }) {
    this.sql = input.sql;
    this.freezeRepository = input.freezeRepository ?? new PilotAdmissionFreezeRepository(input.sql);
    this.reserveFloorMigration = input.reserveFloorMigration;
    this.createIdentityRepository = input.createIdentityRepository
      ?? ((db) => new PilotIdentityRepository(db as any));
    this.createFnfOwnershipRepository = input.createFnfOwnershipRepository
      ?? ((db) => new FnfOwnershipRepository(db as any));
    this.createPilotCutoverRepository = input.createPilotCutoverRepository
      ?? ((db) => new PilotCutoverRepository(db as any));
  }

  private readonly sql: SqlClient;

  async cutover(input: {
    sourceOrgId: string;
    targetOrgSlug: string;
    targetOrgName: string;
    targetUserEmail: string;
    targetUserDisplayName?: string | null;
    targetGithubLogin: string;
    buyerKeyIds: string[];
    tokenCredentialIds: string[];
    actorUserId?: string | null;
    effectiveAt?: Date;
  }): Promise<{
    targetOrgId: string;
    targetUserId: string;
    cutoverRecord: Awaited<ReturnType<PilotCutoverRepositoryLike['createCutoverRecord']>>;
  }> {
    const freezes = this.freezeTargets(input.buyerKeyIds, input.tokenCredentialIds);
    await this.activateFreezes({
      freezes,
      operationKind: 'cutover',
      sourceOrgId: input.sourceOrgId,
      targetOrgId: null,
      actorUserId: input.actorUserId ?? null
    });

    try {
      const result = await this.sql.transaction(async (tx) => {
        const identityRepository = this.createIdentityRepository(tx);
        const fnfOwnershipRepository = this.createFnfOwnershipRepository(tx);
        const pilotCutoverRepository = this.createPilotCutoverRepository(tx);

        const org = await identityRepository.ensureOrg({
          slug: input.targetOrgSlug,
          name: input.targetOrgName
        });
        const user = await identityRepository.ensureUser({
          email: input.targetUserEmail,
          displayName: input.targetUserDisplayName ?? null
        });
        await identityRepository.ensureMembership({
          orgId: org.id,
          userId: user.id,
          role: 'buyer'
        });

        await identityRepository.reassignBuyerKeysToOrg({
          apiKeyIds: input.buyerKeyIds,
          targetOrgId: org.id
        });
        await identityRepository.reassignTokenCredentialsToOrg({
          tokenCredentialIds: input.tokenCredentialIds,
          targetOrgId: org.id
        });

        await Promise.all(input.buyerKeyIds.map((apiKeyId) => fnfOwnershipRepository.upsertBuyerKeyOwnership({
          apiKeyId,
          ownerOrgId: org.id,
          ownerUserId: user.id
        })));

        await Promise.all(input.tokenCredentialIds.map((tokenCredentialId) => fnfOwnershipRepository.upsertTokenCredentialOwnership({
          tokenCredentialId,
          ownerOrgId: org.id,
          capacityOwnerUserId: user.id
        })));

        const cutoverRecord = await pilotCutoverRepository.createCutoverRecord({
          sourceOrgId: input.sourceOrgId,
          targetOrgId: org.id,
          effectiveAt: input.effectiveAt ?? new Date(),
          buyerKeyOwnershipSwapped: true,
          providerCredentialOwnershipSwapped: true,
          reserveFloorMigrationCompleted: true,
          createdByUserId: input.actorUserId ?? null
        });

        await this.reserveFloorMigration.migrateReserveFloors({
          db: tx,
          fromOrgId: input.sourceOrgId,
          toOrgId: org.id,
          targetUserId: user.id,
          cutoverId: cutoverRecord.id,
          actorUserId: input.actorUserId ?? null
        });

        await this.releaseFreezes({
          freezes,
          releaseReason: 'cutover_committed',
          releasedByUserId: input.actorUserId ?? null
        });

        return {
          targetOrgId: org.id,
          targetUserId: user.id,
          cutoverRecord
        };
      });

      return result;
    } catch (error) {
      await this.recordFailures(freezes, error);
      throw error;
    }
  }

  async rollback(input: {
    sourceCutoverId?: string | null;
    targetOrgId: string;
    buyerKeyIds: string[];
    tokenCredentialIds: string[];
    actorUserId?: string | null;
    effectiveAt?: Date;
  }): Promise<{
    rollbackRecord: Awaited<ReturnType<PilotCutoverRepositoryLike['createRollbackRecord']>>;
  }> {
    const freezes = this.freezeTargets(input.buyerKeyIds, input.tokenCredentialIds);
    await this.activateFreezes({
      freezes,
      operationKind: 'rollback',
      sourceOrgId: null,
      targetOrgId: input.targetOrgId,
      actorUserId: input.actorUserId ?? null
    });

    try {
      const result = await this.sql.transaction(async (tx) => {
        const identityRepository = this.createIdentityRepository(tx);
        const fnfOwnershipRepository = this.createFnfOwnershipRepository(tx);
        const pilotCutoverRepository = this.createPilotCutoverRepository(tx);

        await identityRepository.reassignBuyerKeysToOrg({
          apiKeyIds: input.buyerKeyIds,
          targetOrgId: input.targetOrgId
        });
        await identityRepository.reassignTokenCredentialsToOrg({
          tokenCredentialIds: input.tokenCredentialIds,
          targetOrgId: input.targetOrgId
        });

        await Promise.all(input.buyerKeyIds.map((apiKeyId) => fnfOwnershipRepository.upsertBuyerKeyOwnership({
          apiKeyId,
          ownerOrgId: input.targetOrgId,
          ownerUserId: null
        })));

        await Promise.all(input.tokenCredentialIds.map((tokenCredentialId) => fnfOwnershipRepository.upsertTokenCredentialOwnership({
          tokenCredentialId,
          ownerOrgId: input.targetOrgId,
          capacityOwnerUserId: null
        })));

        const rollbackRecord = await pilotCutoverRepository.createRollbackRecord({
          sourceCutoverId: input.sourceCutoverId ?? null,
          effectiveAt: input.effectiveAt ?? new Date(),
          revertedBuyerKeyTargetOrgId: input.targetOrgId,
          revertedProviderCredentialTargetOrgId: input.targetOrgId,
          createdByUserId: input.actorUserId ?? null
        });

        await this.releaseFreezes({
          freezes,
          releaseReason: 'rollback_committed',
          releasedByUserId: input.actorUserId ?? null
        });

        return { rollbackRecord };
      });

      return result;
    } catch (error) {
      await this.recordFailures(freezes, error);
      throw error;
    }
  }

  private freezeTargets(buyerKeyIds: string[], tokenCredentialIds: string[]): FreezeTarget[] {
    return [
      ...buyerKeyIds.map((resourceId) => ({ resourceType: 'buyer_key' as const, resourceId })),
      ...tokenCredentialIds.map((resourceId) => ({ resourceType: 'token_credential' as const, resourceId }))
    ];
  }

  private async activateFreezes(input: {
    freezes: FreezeTarget[];
    operationKind: 'cutover' | 'rollback';
    sourceOrgId: string | null;
    targetOrgId: string | null;
    actorUserId: string | null;
  }): Promise<void> {
    await Promise.all(input.freezes.map((freeze) => this.freezeRepository.activateFreeze({
      resourceType: freeze.resourceType,
      resourceId: freeze.resourceId,
      operationKind: input.operationKind,
      sourceOrgId: input.sourceOrgId,
      targetOrgId: input.targetOrgId,
      actorUserId: input.actorUserId
    })));
  }

  private async releaseFreezes(input: {
    freezes: FreezeTarget[];
    releaseReason: string;
    releasedByUserId: string | null;
  }): Promise<void> {
    await Promise.all(input.freezes.map((freeze) => this.freezeRepository.releaseFreeze({
      resourceType: freeze.resourceType,
      resourceId: freeze.resourceId,
      releaseReason: input.releaseReason,
      releasedByUserId: input.releasedByUserId
    })));
  }

  private async recordFailures(freezes: FreezeTarget[], error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'unknown cutover failure';
    await Promise.all(freezes.map((freeze) => this.freezeRepository.recordFailure({
      resourceType: freeze.resourceType,
      resourceId: freeze.resourceId,
      errorMessage: message
    })));
  }
}
