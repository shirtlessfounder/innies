import type { SqlClient, SqlValue, TransactionContext } from './sqlClient.js';
import { type IdFactory, uuidV4 } from './idFactory.js';
import { TABLES } from './tableNames.js';
import type { RoutingMode } from '../types/phase2Contracts.js';

export type RateCardVersionRow = {
  id: string;
  version_key: string;
  effective_at: string;
  created_at: string;
};

export type RateCardLineItemRow = {
  id: string;
  rate_card_version_id: string;
  provider: string;
  model_pattern: string;
  routing_mode: RoutingMode;
  buyer_debit_minor_per_unit: number;
  contributor_earnings_minor_per_unit: number;
  currency: string;
  created_at: string;
};

export type AppliedRateCard = {
  rateCardVersionId: string;
  versionKey: string;
  provider: string;
  modelPattern: string;
  routingMode: RoutingMode;
  buyerDebitMinorPerUnit: number;
  contributorEarningsMinorPerUnit: number;
  currency: string;
};

export class RateCardRepository {
  constructor(
    private readonly db: SqlClient,
    private readonly createId: IdFactory = uuidV4
  ) {}

  async createVersion(input: {
    versionKey: string;
    effectiveAt: Date;
  }): Promise<RateCardVersionRow> {
    return this.insertVersion(this.db, input);
  }

  async addLineItem(input: {
    rateCardVersionId: string;
    provider: string;
    modelPattern: string;
    routingMode: RoutingMode;
    buyerDebitMinorPerUnit: number;
    contributorEarningsMinorPerUnit: number;
    currency?: string;
  }): Promise<RateCardLineItemRow> {
    return this.insertLineItem(this.db, input);
  }

  async createVersionWithLineItems(input: {
    versionKey: string;
    effectiveAt: Date;
    lineItems: Array<{
      provider: string;
      modelPattern: string;
      routingMode: RoutingMode;
      buyerDebitMinorPerUnit: number;
      contributorEarningsMinorPerUnit: number;
      currency?: string;
    }>;
  }): Promise<{
    version: RateCardVersionRow;
    lineItems: RateCardLineItemRow[];
  }> {
    return this.db.transaction(async (tx) => {
      const version = await this.insertVersion(tx, input);
      const lineItems: RateCardLineItemRow[] = [];
      for (const lineItem of input.lineItems) {
        lineItems.push(await this.insertLineItem(tx, {
          rateCardVersionId: version.id,
          ...lineItem
        }));
      }
      return {
        version,
        lineItems
      };
    });
  }

  async getActiveVersion(at: Date = new Date()): Promise<RateCardVersionRow | null> {
    const sql = `
      select *
      from ${TABLES.rateCardVersions}
      where effective_at <= $1
      order by effective_at desc, created_at desc
      limit 1
    `;
    const result = await this.db.query<RateCardVersionRow>(sql, [at]);
    return result.rowCount === 1 ? result.rows[0] : null;
  }

  async listVersions(limit = 20): Promise<RateCardVersionRow[]> {
    const sql = `
      select *
      from ${TABLES.rateCardVersions}
      order by effective_at desc, created_at desc
      limit $1
    `;
    const result = await this.db.query<RateCardVersionRow>(sql, [Math.max(1, Math.min(100, Math.floor(limit)))]);
    return result.rows;
  }

  async listLineItems(rateCardVersionId: string): Promise<RateCardLineItemRow[]> {
    const sql = `
      select *
      from ${TABLES.rateCardLineItems}
      where rate_card_version_id = $1
      order by provider asc, routing_mode asc, model_pattern asc
    `;
    const result = await this.db.query<RateCardLineItemRow>(sql, [rateCardVersionId]);
    return result.rows;
  }

  async resolveAppliedRate(input: {
    provider: string;
    model: string;
    routingMode: RoutingMode;
    at?: Date;
  }): Promise<AppliedRateCard | null> {
    const sql = `
      select
        v.id as rate_card_version_id,
        v.version_key,
        i.provider,
        i.model_pattern,
        i.routing_mode,
        i.buyer_debit_minor_per_unit,
        i.contributor_earnings_minor_per_unit,
        i.currency
      from ${TABLES.rateCardVersions} v
      join ${TABLES.rateCardLineItems} i
        on i.rate_card_version_id = v.id
      where v.effective_at <= $1
        and i.provider = $2
        and i.routing_mode = $3
        and (i.model_pattern = $4 or i.model_pattern = '*')
      order by
        v.effective_at desc,
        case when i.model_pattern = $4 then 0 else 1 end asc,
        i.created_at desc
      limit 1
    `;
    const provider = input.provider.trim().toLowerCase();
    const result = await this.db.query<{
      rate_card_version_id: string;
      version_key: string;
      provider: string;
      model_pattern: string;
      routing_mode: RoutingMode;
      buyer_debit_minor_per_unit: number;
      contributor_earnings_minor_per_unit: number;
      currency: string;
    }>(sql, [input.at ?? new Date(), provider, input.routingMode, input.model]);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      rateCardVersionId: row.rate_card_version_id,
      versionKey: row.version_key,
      provider: row.provider,
      modelPattern: row.model_pattern,
      routingMode: row.routing_mode,
      buyerDebitMinorPerUnit: Number(row.buyer_debit_minor_per_unit),
      contributorEarningsMinorPerUnit: Number(row.contributor_earnings_minor_per_unit),
      currency: row.currency
    };
  }

  private async expectOneInContext<T>(db: TransactionContext, sql: string, params: SqlValue[]): Promise<T> {
    const result = await db.query<T>(sql, params);
    if (result.rowCount !== 1) {
      throw new Error('expected one rate card row');
    }
    return result.rows[0];
  }

  private async insertVersion(
    db: TransactionContext,
    input: {
      versionKey: string;
      effectiveAt: Date;
    }
  ): Promise<RateCardVersionRow> {
    const sql = `
      insert into ${TABLES.rateCardVersions} (
        id,
        version_key,
        effective_at,
        created_at
      ) values (
        $1,$2,$3,now()
      )
      returning *
    `;

    return this.expectOneInContext<RateCardVersionRow>(db, sql, [
      this.createId(),
      input.versionKey,
      input.effectiveAt
    ]);
  }

  private async insertLineItem(
    db: TransactionContext,
    input: {
      rateCardVersionId: string;
      provider: string;
      modelPattern: string;
      routingMode: RoutingMode;
      buyerDebitMinorPerUnit: number;
      contributorEarningsMinorPerUnit: number;
      currency?: string;
    }
  ): Promise<RateCardLineItemRow> {
    const sql = `
      insert into ${TABLES.rateCardLineItems} (
        id,
        rate_card_version_id,
        provider,
        model_pattern,
        routing_mode,
        buyer_debit_minor_per_unit,
        contributor_earnings_minor_per_unit,
        currency,
        created_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,now()
      )
      on conflict (rate_card_version_id, provider, model_pattern, routing_mode)
      do update set
        buyer_debit_minor_per_unit = excluded.buyer_debit_minor_per_unit,
        contributor_earnings_minor_per_unit = excluded.contributor_earnings_minor_per_unit,
        currency = excluded.currency
      returning *
    `;

    return this.expectOneInContext<RateCardLineItemRow>(db, sql, [
      this.createId(),
      input.rateCardVersionId,
      input.provider.trim().toLowerCase(),
      input.modelPattern.trim(),
      input.routingMode,
      input.buyerDebitMinorPerUnit,
      input.contributorEarningsMinorPerUnit,
      input.currency ?? 'USD'
    ]);
  }
}
