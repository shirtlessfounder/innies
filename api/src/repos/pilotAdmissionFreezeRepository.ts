import type { TransactionContext, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type FreezeResourceType = 'buyer_key' | 'token_credential';
export type FreezeOperationKind = 'cutover' | 'rollback';

export type PilotAdmissionFreezeRow = {
  id: string;
  resource_type: FreezeResourceType;
  resource_id: string;
  operation_kind: FreezeOperationKind;
  source_org_id: string | null;
  target_org_id: string | null;
  actor_user_id: string | null;
  released_at: string | null;
  release_reason: string | null;
  released_by_user_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export class PilotAdmissionFreezeRepository {
  constructor(
    private readonly db: TransactionContext,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async activateFreeze(input: {
    resourceType: FreezeResourceType;
    resourceId: string;
    operationKind: FreezeOperationKind;
    sourceOrgId?: string | null;
    targetOrgId?: string | null;
    actorUserId?: string | null;
  }): Promise<PilotAdmissionFreezeRow> {
    const sql = `
      insert into ${TABLES.pilotAdmissionFreezes} (
        id,
        resource_type,
        resource_id,
        operation_kind,
        source_org_id,
        target_org_id,
        actor_user_id,
        released_at,
        release_reason,
        released_by_user_id,
        last_error,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,null,null,null,null,now(),now()
      )
      on conflict (resource_type, resource_id) where released_at is null
      do update set
        operation_kind = excluded.operation_kind,
        source_org_id = excluded.source_org_id,
        target_org_id = excluded.target_org_id,
        actor_user_id = excluded.actor_user_id,
        last_error = null,
        updated_at = now()
      returning *
    `;

    return this.expectOne<PilotAdmissionFreezeRow>(sql, [
      this.createId(),
      input.resourceType,
      input.resourceId,
      input.operationKind,
      input.sourceOrgId ?? null,
      input.targetOrgId ?? null,
      input.actorUserId ?? null
    ]);
  }

  async releaseFreeze(input: {
    resourceType: FreezeResourceType;
    resourceId: string;
    releasedByUserId?: string | null;
    releaseReason: string;
  }): Promise<boolean> {
    const sql = `
      update ${TABLES.pilotAdmissionFreezes}
      set
        released_at = now(),
        release_reason = $3,
        released_by_user_id = $4,
        updated_at = now()
      where resource_type = $1
        and resource_id = $2
        and released_at is null
    `;
    const result = await this.db.query(sql, [
      input.resourceType,
      input.resourceId,
      input.releaseReason,
      input.releasedByUserId ?? null
    ]);
    return result.rowCount > 0;
  }

  async findActiveFreeze(
    resourceType: FreezeResourceType,
    resourceId: string
  ): Promise<PilotAdmissionFreezeRow | null> {
    const sql = `
      select *
      from ${TABLES.pilotAdmissionFreezes}
      where resource_type = $1
        and resource_id = $2
        and released_at is null
      limit 1
    `;
    const result = await this.db.query<PilotAdmissionFreezeRow>(sql, [resourceType, resourceId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async recordFailure(input: {
    resourceType: FreezeResourceType;
    resourceId: string;
    errorMessage: string;
  }): Promise<boolean> {
    const sql = `
      update ${TABLES.pilotAdmissionFreezes}
      set last_error = $3,
          updated_at = now()
      where resource_type = $1
        and resource_id = $2
        and released_at is null
    `;
    const result = await this.db.query(sql, [
      input.resourceType,
      input.resourceId,
      input.errorMessage
    ]);
    return result.rowCount > 0;
  }

  private async expectOne<T>(sql: string, params: SqlValue[]): Promise<T> {
    const result = await this.db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one pilot admission freeze row');
    }
    return result.rows[0];
  }
}
