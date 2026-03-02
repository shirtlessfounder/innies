type AuditRepoLike = {
  createEvent(input: {
    action: string;
    targetType: string;
    targetId: string;
    actorApiKeyId?: string | null;
    orgId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
};

type AuthLike = {
  apiKeyId: string;
  orgId: string | null;
};

export async function logSensitiveAction(
  repo: AuditRepoLike,
  auth: AuthLike | undefined,
  event: {
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    orgId?: string | null;
  }
): Promise<void> {
  await repo.createEvent({
    actorApiKeyId: auth?.apiKeyId ?? null,
    orgId: event.orgId ?? auth?.orgId ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata
  });
}
