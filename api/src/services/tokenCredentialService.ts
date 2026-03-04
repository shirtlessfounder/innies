import { AuditLogRepository } from '../repos/auditLogRepository.js';
import {
  TokenCredentialRepository,
  type CreateTokenCredentialInput,
  type RotateTokenCredentialInput
} from '../repos/tokenCredentialRepository.js';

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
    const rotated = await this.repo.rotate(input);
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
}
