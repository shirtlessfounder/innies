import type { SqlClient } from './sqlClient.js';

export type UsageMeSummary = {
  totalRequests: number;
  totalUsageUnits: number;
  totalRetailEquivalentMinor: number;
};

export type OrgCapState = {
  spendCapMinor: number | null;
  monthToDateRetailEquivalentMinor: number;
};

export class UsageQueryRepository {
  constructor(private readonly db: SqlClient) {}

  async getOrgSummary(orgId: string, windowDays = 30): Promise<UsageMeSummary> {
    const sql = `
      select
        count(*)::bigint as total_requests,
        coalesce(sum(usage_units), 0)::bigint as total_usage_units,
        coalesce(sum(retail_equivalent_minor), 0)::bigint as total_retail_equivalent_minor
      from hr_usage_ledger
      where org_id = $1
        and entry_type = 'usage'
        and created_at >= now() - ($2::text || ' days')::interval
    `;

    const result = await this.db.query<{
      total_requests: string | number;
      total_usage_units: string | number;
      total_retail_equivalent_minor: string | number;
    }>(sql, [orgId, windowDays]);

    const row = result.rows[0];
    return {
      totalRequests: Number(row.total_requests),
      totalUsageUnits: Number(row.total_usage_units),
      totalRetailEquivalentMinor: Number(row.total_retail_equivalent_minor)
    };
  }

  async getOrgCapState(orgId: string): Promise<OrgCapState | null> {
    const sql = `
      select
        o.spend_cap_minor,
        coalesce(sum(u.retail_equivalent_minor), 0)::bigint as month_to_date_retail_equivalent_minor
      from hr_orgs o
      left join hr_usage_ledger u
        on u.org_id = o.id
        and u.entry_type = 'usage'
        and date_trunc('month', u.created_at) = date_trunc('month', now())
      where o.id = $1
      group by o.spend_cap_minor
    `;

    const result = await this.db.query<{
      spend_cap_minor: string | number | null;
      month_to_date_retail_equivalent_minor: string | number;
    }>(sql, [orgId]);

    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    return {
      spendCapMinor: row.spend_cap_minor === null ? null : Number(row.spend_cap_minor),
      monthToDateRetailEquivalentMinor: Number(row.month_to_date_retail_equivalent_minor)
    };
  }
}
