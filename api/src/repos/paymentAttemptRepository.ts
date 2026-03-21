import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import type { AutoRechargeTrigger, PaymentAttemptKind, PaymentAttemptStatus } from '../services/payments/paymentTypes.js';

export type PaymentAttemptRow = {
  id: string;
  wallet_id: string;
  owner_org_id: string;
  payment_method_id: string | null;
  processor: string;
  kind: PaymentAttemptKind;
  trigger: AutoRechargeTrigger | null;
  status: PaymentAttemptStatus;
  amount_minor: number;
  currency: string;
  processor_checkout_session_id: string | null;
  processor_payment_intent_id: string | null;
  processor_effect_id: string | null;
  idempotency_key: string | null;
  initiated_by_user_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export class PaymentAttemptRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async createAttempt(input: {
    walletId: string;
    ownerOrgId: string;
    paymentMethodId?: string | null;
    kind: PaymentAttemptKind;
    trigger?: AutoRechargeTrigger | null;
    status?: PaymentAttemptStatus;
    amountMinor: number;
    currency?: string;
    idempotencyKey?: string | null;
    initiatedByUserId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<PaymentAttemptRow> {
    const sql = `
      insert into ${TABLES.paymentAttempts} (
        id,
        wallet_id,
        owner_org_id,
        payment_method_id,
        kind,
        trigger,
        status,
        amount_minor,
        currency,
        idempotency_key,
        initiated_by_user_id,
        metadata
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      returning *
    `;
    const params: SqlValue[] = [
      this.createId(),
      input.walletId,
      input.ownerOrgId,
      input.paymentMethodId ?? null,
      input.kind,
      input.trigger ?? null,
      input.status ?? 'pending',
      input.amountMinor,
      input.currency ?? 'USD',
      input.idempotencyKey ?? null,
      input.initiatedByUserId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ];
    const result = await this.db.query<PaymentAttemptRow>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one payment attempt row');
    }
    return result.rows[0];
  }

  async findPendingAutoRechargeByWalletId(walletId: string): Promise<PaymentAttemptRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentAttempts}
      where wallet_id = $1
        and kind = 'auto_recharge'
        and status in ('pending', 'processing')
      order by created_at desc
      limit 1
    `;
    const result = await this.db.query<PaymentAttemptRow>(sql, [walletId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findManualTopUpByIdempotencyKey(input: {
    walletId: string;
    idempotencyKey: string;
  }): Promise<PaymentAttemptRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentAttempts}
      where wallet_id = $1
        and kind = 'manual_topup'
        and idempotency_key = $2
      limit 1
    `;
    const result = await this.db.query<PaymentAttemptRow>(sql, [input.walletId, input.idempotencyKey]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async markProcessing(input: {
    attemptId: string;
    processorCheckoutSessionId?: string | null;
    processorPaymentIntentId?: string | null;
  }): Promise<void> {
    const sql = `
      update ${TABLES.paymentAttempts}
      set status = 'processing',
          processor_checkout_session_id = coalesce($2, processor_checkout_session_id),
          processor_payment_intent_id = coalesce($3, processor_payment_intent_id),
          updated_at = now()
      where id = $1
    `;
    await this.db.query(sql, [
      input.attemptId,
      input.processorCheckoutSessionId ?? null,
      input.processorPaymentIntentId ?? null
    ]);
  }

  async markSucceeded(input: {
    attemptId: string;
    processorEffectId: string;
    processorPaymentIntentId?: string | null;
  }): Promise<void> {
    const sql = `
      update ${TABLES.paymentAttempts}
      set status = 'succeeded',
          processor_effect_id = $2,
          processor_payment_intent_id = coalesce($3, processor_payment_intent_id),
          updated_at = now()
      where id = $1
    `;
    await this.db.query(sql, [input.attemptId, input.processorEffectId, input.processorPaymentIntentId ?? null]);
  }

  async markFailed(input: {
    attemptId: string;
    processorEffectId?: string | null;
    processorPaymentIntentId?: string | null;
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
  }): Promise<void> {
    const sql = `
      update ${TABLES.paymentAttempts}
      set status = 'failed',
          processor_effect_id = coalesce($2, processor_effect_id),
          processor_payment_intent_id = coalesce($3, processor_payment_intent_id),
          last_error_code = $4,
          last_error_message = $5,
          updated_at = now()
      where id = $1
    `;
    await this.db.query(sql, [
      input.attemptId,
      input.processorEffectId ?? null,
      input.processorPaymentIntentId ?? null,
      input.lastErrorCode ?? null,
      input.lastErrorMessage ?? null
    ]);
  }

  async listRecentByWalletId(input: {
    walletId: string;
    limit: number;
  }): Promise<PaymentAttemptRow[]> {
    const sql = `
      select *
      from ${TABLES.paymentAttempts}
      where wallet_id = $1
      order by created_at desc
      limit $2
    `;
    const result = await this.db.query<PaymentAttemptRow>(sql, [input.walletId, input.limit]);
    return result.rows;
  }
}
