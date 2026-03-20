import { ApiKeyRepository } from '../repos/apiKeyRepository.js';
import { FnfOwnershipRepository } from '../repos/fnfOwnershipRepository.js';
import { PilotCutoverRepository } from '../repos/pilotCutoverRepository.js';
import { PilotCutoverFreezeRepository } from '../repos/pilotCutoverFreezeRepository.js';
import { PilotIdentityRepository } from '../repos/pilotIdentityRepository.js';
import { TokenCredentialRepository } from '../repos/tokenCredentialRepository.js';
import { AppError } from '../utils/errors.js';
import { randomUUID } from 'node:crypto';

export type PilotReserveFloorMigrator = {
  migrateReserveFloors(fromOwner: string, toOwner: string, cutoverId: string): Promise<void>;
};

type PilotAccessDeps = {
  apiKeys: Pick<ApiKeyRepository, 'getById' | 'reassignOrg'>;
  tokenCredentials: Pick<TokenCredentialRepository, 'getById' | 'reassignOrg'>;
  fnfOwnership: Pick<FnfOwnershipRepository, 'upsertBuyerKeyOwnership' | 'upsertTokenCredentialOwnership'>;
  cutoverRecords: Pick<PilotCutoverRepository, 'createCutoverRecord' | 'createRollbackRecord' | 'getLatestCommittedCutover'>;
  identities: Pick<PilotIdentityRepository, 'ensureOrg' | 'ensureUser' | 'ensureMembership' | 'upsertGithubIdentity'>;
  freezes: Pick<PilotCutoverFreezeRepository, 'createFreeze' | 'releaseFreeze'>;
  reserveFloors: PilotReserveFloorMigrator;
  createId?: () => string;
};

export class PilotAccessService {
  constructor(private readonly deps: PilotAccessDeps) {}

  async performCutover(input: {
    buyerKeyId: string;
    tokenCredentialIds: string[];
    darrynEmail: string;
    darrynDisplayName?: string;
    darrynGithubLogin?: string;
    darrynGithubUserId?: string;
    createdByUserId?: string | null;
  }): Promise<{
    cutoverId: string;
    sourceOrgId: string;
    targetOrgId: string;
    buyerKeyId: string;
    tokenCredentialIds: string[];
  }> {
    const buyerKey = await this.deps.apiKeys.getById(input.buyerKeyId);
    if (!buyerKey || buyerKey.scope !== 'buyer_proxy' || !buyerKey.org_id) {
      throw new AppError('invalid_request', 400, 'Buyer key must be an active buyer_proxy key with an org');
    }

    const sourceOrgId = buyerKey.org_id;
    const fnfOrg = await this.deps.identities.ensureOrg({
      slug: 'fnf',
      name: 'Friends & Family'
    });
    const darrynUser = await this.deps.identities.ensureUser({
      email: input.darrynEmail,
      displayName: input.darrynDisplayName ?? 'Darryn'
    });
    await this.deps.identities.ensureMembership({
      orgId: fnfOrg.id,
      userId: darrynUser.id,
      role: 'buyer'
    });
    if (input.darrynGithubLogin && input.darrynGithubUserId) {
      await this.deps.identities.upsertGithubIdentity({
        userId: darrynUser.id,
        githubUserId: input.darrynGithubUserId,
        githubLogin: input.darrynGithubLogin,
        githubEmail: input.darrynEmail
      });
    }

    const freeze = await this.deps.freezes.createFreeze({
      operationKind: 'cutover',
      buyerKeyId: input.buyerKeyId,
      tokenCredentialIds: input.tokenCredentialIds,
      sourceOrgId,
      targetOrgId: fnfOrg.id,
      createdByUserId: input.createdByUserId ?? null
    });

    await this.deps.fnfOwnership.upsertBuyerKeyOwnership({
      apiKeyId: input.buyerKeyId,
      ownerOrgId: fnfOrg.id,
      ownerUserId: darrynUser.id
    });
    await this.deps.apiKeys.reassignOrg(input.buyerKeyId, fnfOrg.id);

    for (const tokenCredentialId of input.tokenCredentialIds) {
      const credential = await this.deps.tokenCredentials.getById(tokenCredentialId);
      if (!credential) {
        throw new AppError('invalid_request', 404, 'Token credential not found', { tokenCredentialId });
      }
      await this.deps.fnfOwnership.upsertTokenCredentialOwnership({
        tokenCredentialId,
        ownerOrgId: fnfOrg.id,
        capacityOwnerUserId: darrynUser.id
      });
      await this.deps.tokenCredentials.reassignOrg(tokenCredentialId, fnfOrg.id);
    }

    const cutoverId = this.deps.createId ? this.deps.createId() : randomUUID();
    try {
      await this.deps.reserveFloors.migrateReserveFloors(sourceOrgId, fnfOrg.id, cutoverId);
    } catch (error) {
      throw error;
    }

    const cutover = await this.deps.cutoverRecords.createCutoverRecord({
      id: cutoverId,
      sourceOrgId,
      targetOrgId: fnfOrg.id,
      effectiveAt: new Date(),
      buyerKeyOwnershipSwapped: true,
      providerCredentialOwnershipSwapped: true,
      reserveFloorMigrationCompleted: true,
      createdByUserId: input.createdByUserId ?? null
    });

    await this.deps.freezes.releaseFreeze({
      freezeId: freeze.id,
      releaseReason: 'cutover_committed'
    });

    return {
      cutoverId,
      sourceOrgId,
      targetOrgId: fnfOrg.id,
      buyerKeyId: input.buyerKeyId,
      tokenCredentialIds: input.tokenCredentialIds
    };
  }

  async performRollback(input: {
    buyerKeyId: string;
    tokenCredentialIds: string[];
    sourceCutoverId?: string;
    createdByUserId?: string | null;
  }): Promise<{
    rollbackId: string;
    sourceCutoverId: string | null;
    revertedOrgId: string;
    buyerKeyId: string;
    tokenCredentialIds: string[];
  }> {
    const cutover = await this.deps.cutoverRecords.getLatestCommittedCutover();
    if (!cutover) {
      throw new AppError('invalid_request', 409, 'No committed cutover exists to roll back');
    }

    const revertedOrgId = cutover.source_org_id;
    const freeze = await this.deps.freezes.createFreeze({
      operationKind: 'rollback',
      buyerKeyId: input.buyerKeyId,
      tokenCredentialIds: input.tokenCredentialIds,
      sourceOrgId: cutover.target_org_id,
      targetOrgId: revertedOrgId,
      sourceCutoverId: input.sourceCutoverId ?? cutover.id,
      createdByUserId: input.createdByUserId ?? null
    });

    await this.deps.fnfOwnership.upsertBuyerKeyOwnership({
      apiKeyId: input.buyerKeyId,
      ownerOrgId: revertedOrgId,
      ownerUserId: null
    });
    await this.deps.apiKeys.reassignOrg(input.buyerKeyId, revertedOrgId);

    for (const tokenCredentialId of input.tokenCredentialIds) {
      const credential = await this.deps.tokenCredentials.getById(tokenCredentialId);
      if (!credential) {
        throw new AppError('invalid_request', 404, 'Token credential not found', { tokenCredentialId });
      }
      await this.deps.fnfOwnership.upsertTokenCredentialOwnership({
        tokenCredentialId,
        ownerOrgId: revertedOrgId,
        capacityOwnerUserId: null
      });
      await this.deps.tokenCredentials.reassignOrg(tokenCredentialId, revertedOrgId);
    }

    const rollback = await this.deps.cutoverRecords.createRollbackRecord({
      sourceCutoverId: input.sourceCutoverId ?? cutover.id,
      effectiveAt: new Date(),
      revertedBuyerKeyTargetOrgId: revertedOrgId,
      revertedProviderCredentialTargetOrgId: revertedOrgId,
      createdByUserId: input.createdByUserId ?? null
    });

    await this.deps.freezes.releaseFreeze({
      freezeId: freeze.id,
      releaseReason: 'rollback_committed'
    });

    return {
      rollbackId: rollback.id,
      sourceCutoverId: rollback.source_cutover_id,
      revertedOrgId,
      buyerKeyId: input.buyerKeyId,
      tokenCredentialIds: input.tokenCredentialIds
    };
  }
}
