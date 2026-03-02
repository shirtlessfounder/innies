import type { SqlClient, SqlValue } from './sqlClient.js';
import { newId } from '../utils/ids.js';
import { TABLES } from './tableNames.js';

export type AuditLogInput = {
  action: string;
  targetType: string;
  targetId: string;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  orgId?: string | null;
  metadata?: Record<string, unknown>;
};

export class AuditLogRepository {
  constructor(private readonly db: SqlClient) {}

  async createEvent(input: AuditLogInput): Promise<{ id: string }> {
    const id = newId();
    const sql = `
      insert into ${TABLES.auditLogEvents} (
        id,
        actor_user_id,
        actor_api_key_id,
        org_id,
        action,
        target_type,
        target_id,
        metadata,
        created_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
    `;

    const params: SqlValue[] = [
      id,
      input.actorUserId ?? null,
      input.actorApiKeyId ?? null,
      input.orgId ?? null,
      input.action,
      input.targetType,
      input.targetId,
      input.metadata ?? {}
    ];

    await this.db.query(sql, params);
    return { id };
  }
}
