import type { SqlClient, SqlValue } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';
import type { EarningsBalanceBucket, EarningsEffectType } from '../types/phase2Contracts.js';

export type EarningsLedgerEntryInput = {
  ownerOrgId: string;
  contributorUserId: string;
  meteringEventId?: string | null;
  effectType: EarningsEffectType;
  balanceBucket: EarningsBalanceBucket;
  amountMinor: number;
  currency?: string;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  reason?: string | null;
  withdrawalRequestId?: string | null;
  payoutReference?: string | null;
  metadata?: Record<string, unknown>;
};

export type EarningsLedgerRow = {
  id: string;
  owner_org_id: string;
  contributor_user_id: string;
  metering_event_id: string | null;
  effect_type: EarningsEffectType;
  balance_bucket: EarningsBalanceBucket;
  amount_minor: number;
  currency: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  reason: string | null;
  withdrawal_request_id: string | null;
  payout_reference: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const MANUAL_EARNINGS_EFFECT_TYPES = new Set<EarningsEffectType>([
  'withdrawal_reserve',
  'withdrawal_release',
  'payout_settlement',
  'payout_adjustment'
]);

export class EarningsLedgerRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async appendEntry(input: EarningsLedgerEntryInput): Promise<EarningsLedgerRow> {
    if (MANUAL_EARNINGS_EFFECT_TYPES.has(input.effectType) && !input.reason) {
      throw new Error('manual earnings entries require reason');
    }

    if (
      MANUAL_EARNINGS_EFFECT_TYPES.has(input.effectType)
      && !input.actorUserId
      && !input.actorApiKeyId
    ) {
      throw new Error('manual earnings entries require actor attribution');
    }

    if (!MANUAL_EARNINGS_EFFECT_TYPES.has(input.effectType) && !input.meteringEventId) {
      throw new Error('metering-derived earnings entries require meteringEventId');
    }

    const sql = `
      insert into ${TABLES.earningsLedger} (
        id,
        owner_org_id,
        contributor_user_id,
        metering_event_id,
        effect_type,
        balance_bucket,
        amount_minor,
        currency,
        actor_user_id,
        actor_api_key_id,
        reason,
        withdrawal_request_id,
        payout_reference,
        metadata
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
      )
      on conflict do nothing
      returning *
    `;

    const params: SqlValue[] = [
      this.createId(),
      input.ownerOrgId,
      input.contributorUserId,
      input.meteringEventId ?? null,
      input.effectType,
      input.balanceBucket,
      input.amountMinor,
      input.currency ?? 'USD',
      input.actorUserId ?? null,
      input.actorApiKeyId ?? null,
      input.reason ?? null,
      input.withdrawalRequestId ?? null,
      input.payoutReference ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ];

    const result = await this.db.query<EarningsLedgerRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    if (input.meteringEventId) {
      const existing = await this.findByMeteringEventAndEffectType(input.meteringEventId, input.effectType);
      if (existing) {
        assertEarningsLedgerReplayMatches(input, existing);
        return existing;
      }
    }

    throw new Error('expected one earnings ledger row');
  }

  listByContributorUserId(contributorUserId: string): Promise<EarningsLedgerRow[]> {
    const sql = `
      select *
      from ${TABLES.earningsLedger}
      where contributor_user_id = $1
      order by created_at asc, id asc
    `;
    return this.db.query<EarningsLedgerRow>(sql, [contributorUserId]).then((result) => result.rows);
  }

  listByOwnerOrgAndContributorUserId(input: {
    ownerOrgId: string;
    contributorUserId: string;
  }): Promise<EarningsLedgerRow[]> {
    const sql = `
      select *
      from ${TABLES.earningsLedger}
      where owner_org_id = $1
        and contributor_user_id = $2
      order by created_at asc, id asc
    `;
    return this.db.query<EarningsLedgerRow>(sql, [input.ownerOrgId, input.contributorUserId]).then((result) => result.rows);
  }

  listByMeteringEventId(meteringEventId: string): Promise<EarningsLedgerRow[]> {
    const sql = `
      select *
      from ${TABLES.earningsLedger}
      where metering_event_id = $1
      order by created_at asc, id asc
    `;
    return this.db.query<EarningsLedgerRow>(sql, [meteringEventId]).then((result) => result.rows);
  }

  private async findByMeteringEventAndEffectType(
    meteringEventId: string,
    effectType: EarningsEffectType
  ): Promise<EarningsLedgerRow | null> {
    const sql = `
      select *
      from ${TABLES.earningsLedger}
      where metering_event_id = $1
        and effect_type = $2
      limit 1
    `;
    const result = await this.db.query<EarningsLedgerRow>(sql, [meteringEventId, effectType]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }
}

function assertEarningsLedgerReplayMatches(input: EarningsLedgerEntryInput, row: EarningsLedgerRow): void {
  assertIdempotentReplayMatches('earnings ledger', [
    { field: 'ownerOrgId', expected: input.ownerOrgId, actual: row.owner_org_id },
    { field: 'contributorUserId', expected: input.contributorUserId, actual: row.contributor_user_id },
    { field: 'meteringEventId', expected: input.meteringEventId ?? null, actual: row.metering_event_id },
    { field: 'effectType', expected: input.effectType, actual: row.effect_type },
    { field: 'balanceBucket', expected: input.balanceBucket, actual: row.balance_bucket },
    { field: 'amountMinor', expected: input.amountMinor, actual: row.amount_minor },
    { field: 'currency', expected: input.currency ?? 'USD', actual: row.currency },
    { field: 'actorUserId', expected: input.actorUserId ?? null, actual: row.actor_user_id },
    { field: 'actorApiKeyId', expected: input.actorApiKeyId ?? null, actual: row.actor_api_key_id },
    { field: 'reason', expected: input.reason ?? null, actual: row.reason },
    { field: 'withdrawalRequestId', expected: input.withdrawalRequestId ?? null, actual: row.withdrawal_request_id },
    { field: 'payoutReference', expected: input.payoutReference ?? null, actual: row.payout_reference },
    { field: 'metadata', expected: input.metadata ?? null, actual: row.metadata }
  ]);
}
