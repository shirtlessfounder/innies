import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type BuyerKeyOwnershipRow = {
  api_key_id: string;
  owner_org_id: string;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TokenCredentialOwnershipRow = {
  token_credential_id: string;
  owner_org_id: string;
  capacity_owner_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export class FnfOwnershipRepository {
  constructor(private readonly db: SqlClient) {}

  async upsertBuyerKeyOwnership(input: {
    apiKeyId: string;
    ownerOrgId: string;
    ownerUserId?: string | null;
  }): Promise<BuyerKeyOwnershipRow> {
    const sql = `
      insert into ${TABLES.fnfApiKeyOwnership} (
        api_key_id,
        owner_org_id,
        owner_user_id,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,now(),now()
      )
      on conflict (api_key_id)
      do update set
        owner_org_id = excluded.owner_org_id,
        owner_user_id = excluded.owner_user_id,
        updated_at = now()
      returning *
    `;

    return this.expectOne<BuyerKeyOwnershipRow>(sql, [
      input.apiKeyId,
      input.ownerOrgId,
      input.ownerUserId ?? null
    ]);
  }

  async upsertTokenCredentialOwnership(input: {
    tokenCredentialId: string;
    ownerOrgId: string;
    capacityOwnerUserId?: string | null;
  }): Promise<TokenCredentialOwnershipRow> {
    const sql = `
      insert into ${TABLES.fnfTokenCredentialOwnership} (
        token_credential_id,
        owner_org_id,
        capacity_owner_user_id,
        created_at,
        updated_at
      ) values (
        $1,$2,$3,now(),now()
      )
      on conflict (token_credential_id)
      do update set
        owner_org_id = excluded.owner_org_id,
        capacity_owner_user_id = excluded.capacity_owner_user_id,
        updated_at = now()
      returning *
    `;

    return this.expectOne<TokenCredentialOwnershipRow>(sql, [
      input.tokenCredentialId,
      input.ownerOrgId,
      input.capacityOwnerUserId ?? null
    ]);
  }

  async findBuyerKeyOwnership(apiKeyId: string): Promise<BuyerKeyOwnershipRow | null> {
    const sql = `
      select *
      from ${TABLES.fnfApiKeyOwnership}
      where api_key_id = $1
      limit 1
    `;
    const result = await this.db.query<BuyerKeyOwnershipRow>(sql, [apiKeyId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findTokenCredentialOwnership(tokenCredentialId: string): Promise<TokenCredentialOwnershipRow | null> {
    const sql = `
      select *
      from ${TABLES.fnfTokenCredentialOwnership}
      where token_credential_id = $1
      limit 1
    `;
    const result = await this.db.query<TokenCredentialOwnershipRow>(sql, [tokenCredentialId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  private async expectOne<T>(sql: string, params: SqlValue[]): Promise<T> {
    const result = await this.db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one fnf ownership row');
    }
    return result.rows[0];
  }
}
