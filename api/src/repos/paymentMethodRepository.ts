import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';

export type PaymentMethodRow = {
  id: string;
  wallet_id: string;
  owner_org_id: string;
  payment_profile_id: string;
  processor: string;
  processor_payment_method_id: string;
  processor_customer_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  funding: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
};

export class PaymentMethodRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertMethod(input: {
    walletId: string;
    ownerOrgId: string;
    paymentProfileId: string;
    processor?: string;
    processorPaymentMethodId: string;
    processorCustomerId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding?: string | null;
    status?: string;
  }): Promise<PaymentMethodRow> {
    const sql = `
      insert into ${TABLES.paymentMethods} (
        id,
        wallet_id,
        owner_org_id,
        payment_profile_id,
        processor,
        processor_payment_method_id,
        processor_customer_id,
        brand,
        last4,
        exp_month,
        exp_year,
        funding,
        status
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )
      on conflict (processor_payment_method_id)
      do update set
        wallet_id = excluded.wallet_id,
        owner_org_id = excluded.owner_org_id,
        payment_profile_id = excluded.payment_profile_id,
        processor = excluded.processor,
        processor_customer_id = excluded.processor_customer_id,
        brand = excluded.brand,
        last4 = excluded.last4,
        exp_month = excluded.exp_month,
        exp_year = excluded.exp_year,
        funding = excluded.funding,
        status = excluded.status,
        detached_at = null,
        updated_at = now()
      returning *
    `;
    const params: SqlValue[] = [
      this.createId(),
      input.walletId,
      input.ownerOrgId,
      input.paymentProfileId,
      input.processor ?? 'stripe',
      input.processorPaymentMethodId,
      input.processorCustomerId,
      input.brand,
      input.last4,
      input.expMonth,
      input.expYear,
      input.funding ?? null,
      input.status ?? 'active'
    ];
    const result = await this.db.query<PaymentMethodRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one payment method row');
    }
    return result.rows[0];
  }

  async findDefaultByWalletId(walletId: string): Promise<PaymentMethodRow | null> {
    const sql = `
      select method.*
      from ${TABLES.paymentProfiles} profile
      join ${TABLES.paymentMethods} method
        on method.id = profile.default_payment_method_id
      where profile.wallet_id = $1
        and method.status = 'active'
      limit 1
    `;
    const result = await this.db.query<PaymentMethodRow>(sql, [walletId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findById(paymentMethodId: string): Promise<PaymentMethodRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentMethods}
      where id = $1
      limit 1
    `;
    const result = await this.db.query<PaymentMethodRow>(sql, [paymentMethodId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findByProcessorPaymentMethodId(processorPaymentMethodId: string): Promise<PaymentMethodRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentMethods}
      where processor_payment_method_id = $1
      limit 1
    `;
    const result = await this.db.query<PaymentMethodRow>(sql, [processorPaymentMethodId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async markDetached(input: {
    walletId: string;
    paymentMethodId: string;
  }): Promise<void> {
    const sql = `
      update ${TABLES.paymentMethods}
      set status = 'detached',
          detached_at = now(),
          updated_at = now()
      where wallet_id = $1
        and id = $2
    `;
    await this.db.query(sql, [input.walletId, input.paymentMethodId]);
  }
}
