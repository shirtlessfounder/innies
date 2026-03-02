import type { SqlClient, SqlValue } from './sqlClient.js';
import { TABLES } from './tableNames.js';

export type IncrementalAggregateResult = {
  upsertedRows: number;
};

export type CompactionResult = {
  compactedDays: number;
};

export class AggregatesRepository {
  constructor(private readonly db: SqlClient) {}

  async incrementalUpdate(since: Date): Promise<IncrementalAggregateResult> {
    const sql = `
      with touched_days as (
        select distinct date_trunc('day', created_at)::date as day
        from ${TABLES.usageLedger}
        where entry_type = 'usage' and created_at >= $1
      ),
      rolled as (
        select
          date_trunc('day', created_at)::date as day,
          org_id,
          seller_key_id,
          provider,
          model,
          md5(
            concat_ws(
              '|',
              date_trunc('day', created_at)::date::text,
              org_id::text,
              coalesce(seller_key_id::text, ''),
              provider,
              model
            )
          ) as row_hash,
          count(*) as requests_count,
          sum(usage_units) as usage_units,
          sum(retail_equivalent_minor) as retail_equivalent_minor
        from ${TABLES.usageLedger}
        where
          entry_type = 'usage'
          and date_trunc('day', created_at)::date in (select day from touched_days)
        group by 1,2,3,4,5
      )
      insert into ${TABLES.dailyAggregates} (
        id,
        day,
        org_id,
        seller_key_id,
        provider,
        model,
        requests_count,
        usage_units,
        retail_equivalent_minor,
        created_at,
        updated_at
      )
      select
        (
          substr(row_hash, 1, 8) || '-' ||
          substr(row_hash, 9, 4) || '-' ||
          substr(row_hash, 13, 4) || '-' ||
          substr(row_hash, 17, 4) || '-' ||
          substr(row_hash, 21, 12)
        )::uuid as id,
        day,
        org_id,
        seller_key_id,
        provider,
        model,
        requests_count,
        usage_units,
        retail_equivalent_minor,
        now(),
        now()
      from rolled
      on conflict (id)
      do update set
        day = excluded.day,
        org_id = excluded.org_id,
        seller_key_id = excluded.seller_key_id,
        provider = excluded.provider,
        model = excluded.model,
        requests_count = excluded.requests_count,
        usage_units = excluded.usage_units,
        retail_equivalent_minor = excluded.retail_equivalent_minor,
        updated_at = now()
    `;

    const params: SqlValue[] = [since];
    const result = await this.db.query(sql, params);
    return { upsertedRows: result.rowCount };
  }

  async compactDay(day: string): Promise<CompactionResult> {
    const sql = `
      update ${TABLES.dailyAggregates}
      set updated_at = now()
      where day = $1::date
    `;

    const result = await this.db.query(sql, [day]);
    return { compactedDays: result.rowCount > 0 ? 1 : 0 };
  }
}
