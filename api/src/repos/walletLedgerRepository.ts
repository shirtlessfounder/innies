import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import { assertIdempotentReplayMatches } from './idempotentReplay.js';
import type { WalletEffectType } from '../types/phase2Contracts.js';

export type WalletLedgerEntryInput = {
  entryId?: string;
  walletId: string;
  ownerOrgId: string;
  buyerKeyId?: string | null;
  meteringEventId?: string | null;
  effectType: WalletEffectType;
  amountMinor: number;
  currency?: string;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  reason?: string | null;
  processorEffectId?: string | null;
  metadata?: Record<string, unknown>;
};

export type WalletLedgerRow = {
  id: string;
  wallet_id: string;
  owner_org_id: string;
  buyer_key_id: string | null;
  metering_event_id: string | null;
  effect_type: WalletEffectType;
  amount_minor: number;
  currency: string;
  actor_user_id: string | null;
  reason: string | null;
  processor_effect_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type WalletLedgerCursor = {
  createdAt: string;
  id: string;
};

export type WalletBalanceRow = {
  wallet_id: string;
  balance_minor: number;
};

const MANUAL_WALLET_EFFECT_TYPES = new Set<WalletEffectType>([
  'manual_credit',
  'manual_debit'
]);

const PAYMENT_WALLET_EFFECT_TYPES = new Set<WalletEffectType>([
  'payment_credit',
  'payment_reversal'
]);

export class WalletLedgerRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async appendEntry(input: WalletLedgerEntryInput): Promise<WalletLedgerRow> {
    if (MANUAL_WALLET_EFFECT_TYPES.has(input.effectType) && (!hasManualActorMetadata(input) || !input.reason)) {
      throw new Error('manual wallet entries require actor metadata and reason');
    }

    if (PAYMENT_WALLET_EFFECT_TYPES.has(input.effectType) && !input.processorEffectId) {
      throw new Error('payment wallet entries require processorEffectId');
    }

    if (
      !MANUAL_WALLET_EFFECT_TYPES.has(input.effectType)
      && !PAYMENT_WALLET_EFFECT_TYPES.has(input.effectType)
      && !input.meteringEventId
    ) {
      throw new Error('metering-derived wallet entries require meteringEventId');
    }

    const metadata = manualWalletMetadata(input);
    const sql = `
      insert into ${TABLES.walletLedger} (
        id,
        wallet_id,
        owner_org_id,
        buyer_key_id,
        metering_event_id,
        effect_type,
        amount_minor,
        currency,
        actor_user_id,
        reason,
        processor_effect_id,
        metadata
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      on conflict do nothing
      returning *
    `;

    const params: SqlValue[] = [
      input.entryId ?? this.createId(),
      input.walletId,
      input.ownerOrgId,
      input.buyerKeyId ?? null,
      input.meteringEventId ?? null,
      input.effectType,
      input.amountMinor,
      input.currency ?? 'USD',
      input.actorUserId ?? null,
      input.reason ?? null,
      input.processorEffectId ?? null,
      metadata ? JSON.stringify(metadata) : null
    ];

    const result = await this.db.query<WalletLedgerRow>(sql, params);
    if (result.rowCount === 1) {
      return result.rows[0];
    }

    const existing = await this.findExistingIdempotentEntry(input);
    if (existing) {
      assertWalletLedgerReplayMatches(input, existing);
      return existing;
    }

    throw new Error('expected one wallet ledger row');
  }

  listByWalletId(walletId: string): Promise<WalletLedgerRow[]> {
    const sql = `
      select *
      from ${TABLES.walletLedger}
      where wallet_id = $1
      order by created_at asc, id asc
    `;
    return this.db.query<WalletLedgerRow>(sql, [walletId]).then((result) => result.rows);
  }

  listByMeteringEventId(meteringEventId: string): Promise<WalletLedgerRow[]> {
    const sql = `
      select *
      from ${TABLES.walletLedger}
      where metering_event_id = $1
      order by created_at asc, id asc
    `;
    return this.db.query<WalletLedgerRow>(sql, [meteringEventId]).then((result) => result.rows);
  }

  async readBalance(
    walletId: string,
    db: Pick<TransactionContext, 'query'> = this.db
  ): Promise<{
    walletId: string;
    balanceMinor: number;
  }> {
    const sql = `
      select
        $1::text as wallet_id,
        coalesce(sum(case
          when effect_type in ('manual_credit', 'payment_credit') then amount_minor
          when effect_type in ('buyer_debit', 'buyer_correction', 'buyer_reversal', 'manual_debit', 'payment_reversal') then amount_minor * -1
          else 0
        end), 0)::bigint as balance_minor
      from ${TABLES.walletLedger}
      where wallet_id = $1
    `;
    const result = await db.query<WalletBalanceRow>(sql, [walletId]);
    const row = result.rows[0] ?? {
      wallet_id: walletId,
      balance_minor: 0
    };

    return {
      walletId: row.wallet_id,
      balanceMinor: Number(row.balance_minor)
    };
  }

  async listPageByWalletId(input: {
    walletId: string;
    limit: number;
    cursor?: WalletLedgerCursor | null;
  }): Promise<WalletLedgerRow[]> {
    const params: SqlValue[] = [input.walletId];
    const where: string[] = ['wallet_id = $1'];

    if (input.cursor) {
      params.push(input.cursor.createdAt);
      const createdAtParam = params.length;
      params.push(input.cursor.id);
      const idParam = params.length;
      where.push(`(
        created_at < $${createdAtParam}
        or (created_at = $${createdAtParam} and id < $${idParam})
      )`);
    }

    params.push(Math.max(1, Math.min(100, Math.floor(input.limit))));
    const sql = `
      select *
      from ${TABLES.walletLedger}
      where ${where.join(' and ')}
      order by created_at desc, id desc
      limit $${params.length}
    `;
    const result = await this.db.query<WalletLedgerRow>(sql, params);
    return result.rows;
  }

  private async findExistingIdempotentEntry(input: WalletLedgerEntryInput): Promise<WalletLedgerRow | null> {
    if (input.entryId) {
      const sql = `
        select *
        from ${TABLES.walletLedger}
        where id = $1
        limit 1
      `;
      const result = await this.db.query<WalletLedgerRow>(sql, [input.entryId]);
      return result.rowCount === 1 ? result.rows[0] : null;
    }

    if (input.meteringEventId) {
      const sql = `
        select *
        from ${TABLES.walletLedger}
        where metering_event_id = $1
          and effect_type = $2
        limit 1
      `;
      const result = await this.db.query<WalletLedgerRow>(sql, [input.meteringEventId, input.effectType]);
      return result.rowCount === 1 ? result.rows[0] : null;
    }

    if (input.processorEffectId) {
      const sql = `
        select *
        from ${TABLES.walletLedger}
        where processor_effect_id = $1
          and effect_type = $2
        limit 1
      `;
      const result = await this.db.query<WalletLedgerRow>(sql, [input.processorEffectId, input.effectType]);
      return result.rowCount === 1 ? result.rows[0] : null;
    }

    return null;
  }
}

function assertWalletLedgerReplayMatches(input: WalletLedgerEntryInput, row: WalletLedgerRow): void {
  assertIdempotentReplayMatches('wallet ledger', [
    { field: 'entryId', expected: input.entryId ?? row.id, actual: row.id },
    { field: 'walletId', expected: input.walletId, actual: row.wallet_id },
    { field: 'ownerOrgId', expected: input.ownerOrgId, actual: row.owner_org_id },
    { field: 'buyerKeyId', expected: input.buyerKeyId ?? null, actual: row.buyer_key_id },
    { field: 'meteringEventId', expected: input.meteringEventId ?? null, actual: row.metering_event_id },
    { field: 'effectType', expected: input.effectType, actual: row.effect_type },
    { field: 'amountMinor', expected: input.amountMinor, actual: row.amount_minor },
    { field: 'currency', expected: input.currency ?? 'USD', actual: row.currency },
    { field: 'actorUserId', expected: input.actorUserId ?? null, actual: row.actor_user_id },
    { field: 'reason', expected: input.reason ?? null, actual: row.reason },
    { field: 'processorEffectId', expected: input.processorEffectId ?? null, actual: row.processor_effect_id },
    { field: 'metadata', expected: manualWalletMetadata(input) ?? null, actual: row.metadata }
  ]);
}

function hasManualActorMetadata(input: WalletLedgerEntryInput): boolean {
  return Boolean(input.actorUserId || input.actorApiKeyId);
}

function manualWalletMetadata(input: WalletLedgerEntryInput): Record<string, unknown> | undefined {
  if (!input.actorApiKeyId) {
    return input.metadata;
  }

  return {
    ...(input.metadata ?? {}),
    actorApiKeyId: input.actorApiKeyId
  };
}
