import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type PilotCutoverFreezeOperationKind = 'cutover' | 'rollback';

export type PilotCutoverFreezeRow = {
  id: string;
  operation_kind: PilotCutoverFreezeOperationKind;
  buyer_key_id: string;
  source_org_id: string;
  target_org_id: string;
  source_cutover_id: string | null;
  created_by_user_id: string | null;
  frozen_at: string;
  released_at: string | null;
  release_reason: string | null;
};

export class PilotCutoverFreezeRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async createFreeze(input: {
    operationKind: PilotCutoverFreezeOperationKind;
    buyerKeyId: string;
    tokenCredentialIds: string[];
    sourceOrgId: string;
    targetOrgId: string;
    sourceCutoverId?: string | null;
    createdByUserId?: string | null;
  }): Promise<PilotCutoverFreezeRow> {
    return this.db.transaction(async (tx) => {
      const freezeId = this.createId();
      const freeze = await this.insertFreeze(tx, freezeId, input);
      if (input.tokenCredentialIds.length > 0) {
        await this.insertFrozenCredentials(tx, freezeId, input.tokenCredentialIds);
      }
      return freeze;
    });
  }

  async findActiveByBuyerKeyId(buyerKeyId: string): Promise<PilotCutoverFreezeRow | null> {
    const sql = `
      select *
      from ${TABLES.pilotCutoverFreezes}
      where buyer_key_id = $1
        and released_at is null
      order by frozen_at desc
      limit 1
    `;
    const result = await this.db.query<PilotCutoverFreezeRow>(sql, [buyerKeyId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findActiveByTokenCredentialId(tokenCredentialId: string): Promise<PilotCutoverFreezeRow | null> {
    const sql = `
      select freeze.*
      from ${TABLES.pilotCutoverFreezes} freeze
      join ${TABLES.pilotCutoverFreezeCredentials} frozen
        on frozen.freeze_id = freeze.id
      where frozen.token_credential_id = $1
        and freeze.released_at is null
      order by freeze.frozen_at desc
      limit 1
    `;
    const result = await this.db.query<PilotCutoverFreezeRow>(sql, [tokenCredentialId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async releaseFreeze(input: {
    freezeId: string;
    releaseReason: string;
  }): Promise<boolean> {
    const sql = `
      update ${TABLES.pilotCutoverFreezes}
      set
        released_at = now(),
        release_reason = $2
      where id = $1
        and released_at is null
    `;
    const result = await this.db.query(sql, [
      input.freezeId,
      input.releaseReason
    ]);
    return result.rowCount === 1;
  }

  private async insertFreeze(
    tx: TransactionContext,
    freezeId: string,
    input: {
      operationKind: PilotCutoverFreezeOperationKind;
      buyerKeyId: string;
      sourceOrgId: string;
      targetOrgId: string;
      sourceCutoverId?: string | null;
      createdByUserId?: string | null;
    }
  ): Promise<PilotCutoverFreezeRow> {
    const sql = `
      insert into ${TABLES.pilotCutoverFreezes} (
        id,
        operation_kind,
        buyer_key_id,
        source_org_id,
        target_org_id,
        source_cutover_id,
        created_by_user_id,
        frozen_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,now()
      )
      returning *
    `;

    const result = await tx.query<PilotCutoverFreezeRow>(sql, [
      freezeId,
      input.operationKind,
      input.buyerKeyId,
      input.sourceOrgId,
      input.targetOrgId,
      input.sourceCutoverId ?? null,
      input.createdByUserId ?? null
    ]);

    if (result.rowCount !== 1) {
      throw new Error('expected one pilot cutover freeze row');
    }

    return result.rows[0];
  }

  private async insertFrozenCredentials(
    tx: TransactionContext,
    freezeId: string,
    tokenCredentialIds: string[]
  ): Promise<void> {
    const values = tokenCredentialIds
      .map((_, index) => `($1,$${index + 2},now())`)
      .join(', ');
    const sql = `
      insert into ${TABLES.pilotCutoverFreezeCredentials} (
        freeze_id,
        token_credential_id,
        created_at
      ) values ${values}
    `;

    await tx.query(sql, [
      freezeId,
      ...tokenCredentialIds
    ]);
  }
}
