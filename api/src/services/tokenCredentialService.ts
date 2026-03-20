import { AuditLogRepository } from '../repos/auditLogRepository.js';
import {
  TokenCredentialRepository,
  type CreateTokenCredentialInput,
  type RotateTokenCredentialInput,
  type UpdateTokenCredentialContributionCapInput
} from '../repos/tokenCredentialRepository.js';
import { AppError } from '../utils/errors.js';

type ActorContext = {
  actorApiKeyId?: string | null;
  actorUserId?: string | null;
};

export class TokenCredentialService {
  constructor(
    private readonly repo: TokenCredentialRepository,
    private readonly auditLogs: AuditLogRepository
  ) {}

  async create(input: CreateTokenCredentialInput, actor?: ActorContext): Promise<{ id: string; rotationVersion: number }> {
    const created = await this.repo.create(input);
    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: input.orgId,
      action: 'token_credential.create',
      targetType: 'token_credential',
      targetId: created.id,
      metadata: {
        provider: input.provider,
        authScheme: input.authScheme,
        debugLabel: input.debugLabel ?? null,
        rotationVersion: created.rotationVersion
      }
    });
    return created;
  }

  async rotate(input: RotateTokenCredentialInput, actor?: ActorContext): Promise<{ id: string; rotationVersion: number; previousId: string | null }> {
    let rotated: { id: string; rotationVersion: number; previousId: string | null };
    try {
      rotated = await this.repo.rotate(input);
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes('not found or not rotatable for org/provider')
      ) {
        throw new AppError('invalid_request', 400, error.message, {
          previousCredentialId: input.previousCredentialId ?? null,
          provider: input.provider,
          orgId: input.orgId
        });
      }
      throw error;
    }
    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: input.orgId,
      action: 'token_credential.rotate',
      targetType: 'token_credential',
      targetId: rotated.id,
      metadata: {
        provider: input.provider,
        authScheme: input.authScheme,
        debugLabel: input.debugLabel ?? null,
        rotationVersion: rotated.rotationVersion,
        previousId: rotated.previousId
      }
    });
    return rotated;
  }

  async revoke(id: string, orgId: string, actor?: ActorContext): Promise<boolean> {
    const revoked = await this.repo.revoke(id);
    if (revoked) {
      await this.auditLogs.createEvent({
        actorApiKeyId: actor?.actorApiKeyId ?? null,
        actorUserId: actor?.actorUserId ?? null,
        orgId,
        action: 'token_credential.revoke',
        targetType: 'token_credential',
        targetId: id
      });
    }
    return revoked;
  }

  async pause(
    id: string,
    actor?: ActorContext
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    debugLabel: string | null;
    status: 'paused';
    changed: boolean;
  } | null> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      return null;
    }
    if (existing.status === 'paused') {
      return {
        id,
        orgId: existing.orgId,
        provider: existing.provider,
        debugLabel: existing.debugLabel,
        status: 'paused',
        changed: false,
      };
    }
    if (existing.status !== 'active') {
      throw new AppError('invalid_request', 409, 'Only active token credentials can be paused', {
        credentialId: id,
        status: existing.status,
      });
    }

    const changed = await this.repo.pause(id);
    if (!changed) {
      return null;
    }

    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: existing.orgId,
      action: 'token_credential.pause',
      targetType: 'token_credential',
      targetId: id,
      metadata: {
        provider: existing.provider,
        debugLabel: existing.debugLabel,
      }
    });

    return {
      id,
      orgId: existing.orgId,
      provider: existing.provider,
      debugLabel: existing.debugLabel,
      status: 'paused',
      changed: true,
    };
  }

  async unpause(
    id: string,
    actor?: ActorContext
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    debugLabel: string | null;
    status: 'active';
    changed: boolean;
  } | null> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      return null;
    }
    if (existing.status === 'active') {
      return {
        id,
        orgId: existing.orgId,
        provider: existing.provider,
        debugLabel: existing.debugLabel,
        status: 'active',
        changed: false,
      };
    }
    if (existing.status !== 'paused') {
      throw new AppError('invalid_request', 409, 'Only paused token credentials can be unpaused', {
        credentialId: id,
        status: existing.status,
      });
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppError('invalid_request', 409, 'Token credential is expired and cannot be unpaused', {
        credentialId: id,
        status: existing.status,
      });
    }

    const changed = await this.repo.unpause(id);
    if (!changed) {
      return null;
    }

    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: existing.orgId,
      action: 'token_credential.unpause',
      targetType: 'token_credential',
      targetId: id,
      metadata: {
        provider: existing.provider,
        debugLabel: existing.debugLabel,
      }
    });

    return {
      id,
      orgId: existing.orgId,
      provider: existing.provider,
      debugLabel: existing.debugLabel,
      status: 'active',
      changed: true,
    };
  }

  async setRefreshToken(id: string, orgId: string, refreshToken: string | null, actor?: ActorContext): Promise<boolean> {
    const updated = await this.repo.setRefreshToken(id, refreshToken);
    if (updated) {
      await this.auditLogs.createEvent({
        actorApiKeyId: actor?.actorApiKeyId ?? null,
        actorUserId: actor?.actorUserId ?? null,
        orgId,
        action: 'token_credential.update_refresh_token',
        targetType: 'token_credential',
        targetId: id,
        metadata: {
          hasRefreshToken: refreshToken !== null
        }
      });
    }
    return updated;
  }

  async updateDebugLabel(
    id: string,
    debugLabel: string,
    actor?: ActorContext
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    debugLabel: string;
    changed: boolean;
  } | null> {
    const existing = await this.repo.getById(id);
    if (!existing || existing.status === 'revoked') {
      return null;
    }

    if (existing.debugLabel === debugLabel) {
      return {
        id,
        orgId: existing.orgId,
        provider: existing.provider,
        debugLabel,
        changed: false,
      };
    }

    const updated = await this.repo.updateDebugLabel(id, debugLabel);
    if (!updated) {
      return null;
    }

    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: updated.orgId,
      action: 'token_credential.update_debug_label',
      targetType: 'token_credential',
      targetId: id,
      metadata: {
        provider: updated.provider,
        previousDebugLabel: existing.debugLabel,
        debugLabel: updated.debugLabel,
      }
    });

    return {
      ...updated,
      changed: true,
    };
  }

  async updateContributionCap(
    id: string,
    input: UpdateTokenCredentialContributionCapInput,
    actor?: ActorContext
  ): Promise<{
    id: string;
    orgId: string;
    provider: string;
    fiveHourReservePercent: number;
    sevenDayReservePercent: number;
  } | null> {
    const existing = await this.repo.getById(id);
    if (!existing) {
      return null;
    }
    if (existing.provider !== 'anthropic' && existing.provider !== 'openai') {
      throw new AppError(
        'invalid_request',
        400,
        'Contribution caps are only supported for Claude and OpenAI token credentials',
        { credentialId: id, provider: existing.provider }
      );
    }

    const updated = await this.repo.updateContributionCap(id, input);
    if (!updated) {
      return null;
    }

    await this.auditLogs.createEvent({
      actorApiKeyId: actor?.actorApiKeyId ?? null,
      actorUserId: actor?.actorUserId ?? null,
      orgId: updated.orgId,
      action: 'token_credential.update_contribution_cap',
      targetType: 'token_credential',
      targetId: id,
      metadata: {
        fiveHourReservePercent: updated.fiveHourReservePercent,
        sevenDayReservePercent: updated.sevenDayReservePercent
      }
    });

    return updated;
  }
}
