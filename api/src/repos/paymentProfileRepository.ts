import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type PaymentProfileRow = {
  id: string;
  wallet_id: string;
  owner_org_id: string;
  processor: string;
  processor_customer_id: string;
  default_payment_method_id: string | null;
  created_at: string;
  updated_at: string;
};

export class PaymentProfileRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async findByWalletId(walletId: string): Promise<PaymentProfileRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentProfiles}
      where wallet_id = $1
      limit 1
    `;
    const result = await this.db.query<PaymentProfileRow>(sql, [walletId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async ensureProfile(input: {
    walletId: string;
    ownerOrgId: string;
    processorCustomerId: string;
    processor?: string;
  }): Promise<PaymentProfileRow> {
    const sql = `
      insert into ${TABLES.paymentProfiles} (
        id,
        wallet_id,
        owner_org_id,
        processor,
        processor_customer_id
      ) values (
        $1,$2,$3,$4,$5
      )
      on conflict (wallet_id)
      do update set
        owner_org_id = excluded.owner_org_id,
        updated_at = now()
      returning *
    `;
    const params: SqlValue[] = [
      this.createId(),
      input.walletId,
      input.ownerOrgId,
      input.processor ?? 'stripe',
      input.processorCustomerId
    ];
    const result = await this.db.query<PaymentProfileRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one payment profile row');
    }
    return result.rows[0];
  }

  async setDefaultPaymentMethod(input: {
    walletId: string;
    paymentMethodId: string | null;
  }): Promise<void> {
    const sql = `
      update ${TABLES.paymentProfiles}
      set default_payment_method_id = $2,
          updated_at = now()
      where wallet_id = $1
    `;
    await this.db.query(sql, [input.walletId, input.paymentMethodId]);
  }
}
