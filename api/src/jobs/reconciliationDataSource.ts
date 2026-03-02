import type { SqlClient } from '../repos/sqlClient.js';
import { TABLES } from '../repos/tableNames.js';
import type { ReconciliationDataSource, ReconciliationProviderSnapshot } from './reconciliationJob.js';

export class C1ReconciliationDataSource implements ReconciliationDataSource {
  constructor(private readonly db: SqlClient) {}

  async snapshot(runDate: string): Promise<ReconciliationProviderSnapshot[]> {
    const sql = `
      select
        provider,
        coalesce(sum(usage_units), 0)::bigint as expected_units,
        coalesce(sum(usage_units), 0)::bigint as actual_units
      from ${TABLES.usageLedger}
      where created_at::date = $1::date and entry_type = 'usage'
      group by provider
      order by provider asc
    `;

    const result = await this.db.query<{
      provider: string;
      expected_units: number;
      actual_units: number;
    }>(sql, [runDate]);

    return result.rows.map((row) => ({
      provider: row.provider,
      expectedUnits: Number(row.expected_units),
      actualUnits: Number(row.actual_units),
      notes: 'C1 source: provider usage mirrored from internal ledger until provider pull is wired'
    }));
  }
}
