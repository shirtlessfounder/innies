import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type AutoRechargeSettingsRow = {
  wallet_id: string;
  owner_org_id: string;
  enabled: boolean;
  amount_minor: number;
  currency: string;
  payment_method_id: string | null;
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export class AutoRechargeSettingsRepository {
  constructor(private readonly db: SqlClient) {}

  async findByWalletId(walletId: string): Promise<AutoRechargeSettingsRow | null> {
    const sql = `
      select *
      from ${TABLES.autoRechargeSettings}
      where wallet_id = $1
      limit 1
    `;
    const result = await this.db.query<AutoRechargeSettingsRow>(sql, [walletId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async upsertSettings(input: {
    walletId: string;
    ownerOrgId: string;
    enabled: boolean;
    amountMinor: number;
    currency?: string;
    paymentMethodId?: string | null;
    updatedByUserId?: string | null;
  }): Promise<AutoRechargeSettingsRow> {
    const sql = `
      insert into ${TABLES.autoRechargeSettings} (
        wallet_id,
        owner_org_id,
        enabled,
        amount_minor,
        currency,
        payment_method_id,
        updated_by_user_id
      ) values (
        $1,$2,$3,$4,$5,$6,$7
      )
      on conflict (wallet_id)
      do update set
        owner_org_id = excluded.owner_org_id,
        enabled = excluded.enabled,
        amount_minor = excluded.amount_minor,
        currency = excluded.currency,
        payment_method_id = excluded.payment_method_id,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = now()
      returning *
    `;
    const params: SqlValue[] = [
      input.walletId,
      input.ownerOrgId,
      input.enabled,
      input.amountMinor,
      input.currency ?? 'USD',
      input.paymentMethodId ?? null,
      input.updatedByUserId ?? null
    ];
    const result = await this.db.query<AutoRechargeSettingsRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one auto recharge settings row');
    }
    return result.rows[0];
  }
}
