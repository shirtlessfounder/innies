import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type CutoverRecordRow = {
  id: string;
  source_org_id: string;
  target_org_id: string;
  effective_at: string;
  buyer_key_ownership_swapped: boolean;
  provider_credential_ownership_swapped: boolean;
  reserve_floor_migration_completed: boolean;
  created_by_user_id: string | null;
  created_at: string;
};

export type RollbackRecordRow = {
  id: string;
  source_cutover_id: string | null;
  effective_at: string;
  reverted_buyer_key_target_org_id: string;
  reverted_provider_credential_target_org_id: string;
  created_by_user_id: string | null;
  created_at: string;
};

export class PilotCutoverRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async createCutoverRecord(input: {
    sourceOrgId: string;
    targetOrgId: string;
    effectiveAt: Date;
    buyerKeyOwnershipSwapped: boolean;
    providerCredentialOwnershipSwapped: boolean;
    reserveFloorMigrationCompleted: boolean;
    createdByUserId?: string | null;
  }): Promise<CutoverRecordRow> {
    const sql = `
      insert into ${TABLES.cutoverRecords} (
        id,
        source_org_id,
        target_org_id,
        effective_at,
        buyer_key_ownership_swapped,
        provider_credential_ownership_swapped,
        reserve_floor_migration_completed,
        created_by_user_id,
        created_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,now()
      )
      returning *
    `;

    return this.expectOne<CutoverRecordRow>(sql, [
      this.createId(),
      input.sourceOrgId,
      input.targetOrgId,
      input.effectiveAt,
      input.buyerKeyOwnershipSwapped,
      input.providerCredentialOwnershipSwapped,
      input.reserveFloorMigrationCompleted,
      input.createdByUserId ?? null
    ]);
  }

  async createRollbackRecord(input: {
    sourceCutoverId?: string | null;
    effectiveAt: Date;
    revertedBuyerKeyTargetOrgId: string;
    revertedProviderCredentialTargetOrgId: string;
    createdByUserId?: string | null;
  }): Promise<RollbackRecordRow> {
    const sql = `
      insert into ${TABLES.rollbackRecords} (
        id,
        source_cutover_id,
        effective_at,
        reverted_buyer_key_target_org_id,
        reverted_provider_credential_target_org_id,
        created_by_user_id,
        created_at
      ) values (
        $1,$2,$3,$4,$5,$6,now()
      )
      returning *
    `;

    return this.expectOne<RollbackRecordRow>(sql, [
      this.createId(),
      input.sourceCutoverId ?? null,
      input.effectiveAt,
      input.revertedBuyerKeyTargetOrgId,
      input.revertedProviderCredentialTargetOrgId,
      input.createdByUserId ?? null
    ]);
  }

  async getLatestCommittedCutover(): Promise<CutoverRecordRow | null> {
    const sql = `
      select *
      from ${TABLES.cutoverRecords}
      where buyer_key_ownership_swapped = true
        and provider_credential_ownership_swapped = true
        and reserve_floor_migration_completed = true
      order by effective_at desc, created_at desc
      limit 1
    `;
    const result = await this.db.query<CutoverRecordRow>(sql);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async getLatestCommittedRollback(): Promise<RollbackRecordRow | null> {
    const sql = `
      select *
      from ${TABLES.rollbackRecords}
      order by effective_at desc, created_at desc
      limit 1
    `;
    const result = await this.db.query<RollbackRecordRow>(sql);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  private async expectOne<T>(sql: string, params: SqlValue[]): Promise<T> {
    const result = await this.db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one cutover row');
    }
    return result.rows[0];
  }
}
