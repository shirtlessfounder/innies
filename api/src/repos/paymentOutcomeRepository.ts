import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';
import type { PaymentWalletEffectType } from '../services/payments/paymentTypes.js';

export type PaymentOutcomeRow = {
  id: string;
  wallet_id: string;
  owner_org_id: string;
  payment_attempt_id: string | null;
  processor: string;
  processor_event_id: string;
  processor_effect_id: string;
  effect_type: PaymentWalletEffectType;
  amount_minor: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  wallet_recorded_at: string | null;
  created_at: string;
};

export class PaymentOutcomeRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async upsertOutcome(input: {
    walletId: string;
    ownerOrgId: string;
    paymentAttemptId?: string | null;
    processor?: string;
    processorEventId: string;
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
    amountMinor: number;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaymentOutcomeRow> {
    const sql = `
      insert into ${TABLES.paymentOutcomes} (
        id,
        wallet_id,
        owner_org_id,
        payment_attempt_id,
        processor,
        processor_event_id,
        processor_effect_id,
        effect_type,
        amount_minor,
        currency,
        metadata
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      )
      on conflict (processor_effect_id) do nothing
      returning *
    `;
    const params: SqlValue[] = [
      this.createId(),
      input.walletId,
      input.ownerOrgId,
      input.paymentAttemptId ?? null,
      input.processor ?? 'stripe',
      input.processorEventId,
      input.processorEffectId,
      input.effectType,
      input.amountMinor,
      input.currency ?? 'USD',
      input.metadata ? JSON.stringify(input.metadata) : null
    ];
    const result = await this.db.query<PaymentOutcomeRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findByProcessorEffectId({
      processorEffectId: input.processorEffectId,
      effectType: input.effectType
    });
    if (!existing) {
      throw new Error('expected one payment outcome row');
    }

    assertIdempotentReplayMatches('payment outcome', [
      { field: 'walletId', expected: input.walletId, actual: existing.wallet_id },
      { field: 'ownerOrgId', expected: input.ownerOrgId, actual: existing.owner_org_id },
      { field: 'paymentAttemptId', expected: input.paymentAttemptId ?? null, actual: existing.payment_attempt_id },
      { field: 'processorEffectId', expected: input.processorEffectId, actual: existing.processor_effect_id },
      { field: 'effectType', expected: input.effectType, actual: existing.effect_type },
      { field: 'amountMinor', expected: input.amountMinor, actual: existing.amount_minor },
      { field: 'currency', expected: input.currency ?? 'USD', actual: existing.currency }
    ]);
    return existing;
  }

  async findByProcessorEffectId(input: {
    processorEffectId: string;
    effectType: PaymentWalletEffectType;
  }): Promise<PaymentOutcomeRow | null> {
    const sql = `
      select *
      from ${TABLES.paymentOutcomes}
      where processor_effect_id = $1
        and effect_type = $2
      limit 1
    `;
    const result = await this.db.query<PaymentOutcomeRow>(sql, [input.processorEffectId, input.effectType]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async findLatestUnrecordedAutoRechargeCreditByWalletId(walletId: string): Promise<PaymentOutcomeRow | null> {
    const sql = `
      select outcome.*
      from ${TABLES.paymentOutcomes} outcome
      join ${TABLES.paymentAttempts} attempt
        on attempt.id = outcome.payment_attempt_id
      where outcome.wallet_id = $1
        and outcome.effect_type = 'payment_credit'
        and outcome.wallet_recorded_at is null
        and attempt.kind = 'auto_recharge'
      order by outcome.created_at desc
      limit 1
    `;
    const result = await this.db.query<PaymentOutcomeRow>(sql, [walletId]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async markRecorded(
    processorEffectId: string,
    db: Pick<TransactionContext, 'query'> = this.db
  ): Promise<void> {
    const sql = `
      update ${TABLES.paymentOutcomes}
      set wallet_recorded_at = coalesce(wallet_recorded_at, now())
      where processor_effect_id = $1
    `;
    await db.query(sql, [processorEffectId]);
  }
}
