import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../src/repos/analyticsRepository.js';
import { MockSqlClient } from './testHelpers.js';
import type { SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';

class SequenceSqlClient extends MockSqlClient {
  constructor(private readonly steps: Array<SqlQueryResult | Error>) {
    super({ rows: [], rowCount: 0 });
  }

  override async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.steps.shift();
    if (next instanceof Error) {
      throw next;
    }
    return (next ?? { rows: [], rowCount: 0 }) as SqlQueryResult<T>;
  }

  override async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

describe('AnalyticsRepository', () => {
  it('reads token usage from canonical usage ledger rows only', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenUsage({ window: '24h', provider: 'openai', source: 'direct' });

    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
  });

  it('uses the default buyer provider when buyer rows have no explicit preference', async () => {
    const previousDefault = process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT;
    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = 'anthropic';

    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getBuyers({ window: '24h', provider: 'openai', source: 'direct' });

    expect(db.queries[0]?.params).toEqual(['anthropic', 'openai', 'direct']);

    process.env.BUYER_PROVIDER_PREFERENCE_DEFAULT = previousDefault;
  });

  it('applies provider filters to system token inventory queries', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getSystemSummary({ window: '24h', provider: 'openai' });

    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[1]?.sql).toContain('FROM in_token_credentials where provider = $1');
    expect(db.queries[1]?.params).toEqual(['openai']);
    expect(db.queries[2]?.sql).toContain('AND provider = $1');
    expect(db.queries[2]?.params).toEqual(['openai']);
    expect(db.queries[3]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[4]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[5]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[6]?.sql).toContain("AND ul.entry_type = 'usage'");
  });

  it('uses routing metadata request_source in token routing filters, including 24h side counts', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenRouting({ window: '7d', provider: 'openai', source: 'direct' });

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.sql).toContain("nullif(re.route_decision->>'request_source', '')");
    expect(db.queries[0]?.params).toEqual(['openai', 'direct', 'openai', 'direct']);
  });

  it('ignores source filters in token health queries and anchors cycle windows by event timestamps', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '7d', provider: 'anthropic', source: 'openclaw' });

    expect(db.queries[0]?.params).toEqual(['anthropic']);
    expect(db.queries[0]?.sql).toContain("cr.maxed_at >= now() - interval '7 days'");
    expect(db.queries[0]?.sql).toContain("cr.reactivated_at >= now() - interval '7 days'");
    expect(db.queries[0]?.sql).toContain('count(DISTINCT re.request_id) AS request_count');
    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[0]?.sql).toContain('WHERE cr.reactivated_at IS NOT NULL');
    expect(db.queries[0]?.sql).not.toContain("route_decision->>'request_source'");
  });

  it('derives capacity-gated utilization from per-cycle daily rates instead of monthly limits', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '1m', provider: 'openai' });

    expect(db.queries[0]?.sql).toContain('percentile_cont(0.5) WITHIN GROUP (ORDER BY daily_capacity_units)');
    expect(db.queries[0]?.sql).toContain('count(*) FILTER (WHERE daily_capacity_units IS NOT NULL)::bigint AS valid_capacity_cycles');
    expect(db.queries[0]?.sql).toContain('coalesce(cs.valid_capacity_cycles, 0) >= 2');
    expect(db.queries[0]?.sql).toContain('coalesce(uu.usage_units_24h, 0)::numeric / cs.estimated_daily_capacity_units');
    expect(db.queries[0]?.sql).toContain("ul.created_at >= now() - interval '24 hours'");
  });

  it('joins Claude provider-usage snapshots into token health analytics and nulls non-Claude reserve fields', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '7d', provider: 'anthropic' });

    expect(db.queries[0]?.sql).toContain(`from in_token_credential_provider_usage pu`);
    expect(db.queries[0]?.sql).toContain(`left join provider_usage pu on pu.token_credential_id = cb.id`);
    expect(db.queries[0]?.sql).toContain(`case
            when tc.provider = 'anthropic' then tc.five_hour_reserve_percent`);
    expect(db.queries[0]?.sql).toContain(`pu.five_hour_utilization_ratio`);
    expect(db.queries[0]?.sql).toContain(`five_hour_contribution_cap_exhausted`);
    expect(db.queries[0]?.sql).toContain(`pu.provider_usage_fetched_at`);
    expect(db.queries[0]?.sql).toContain(`tc.last_refresh_error`);
    expect(db.queries[0]?.sql).toContain(`ce.event_type = 'contribution_cap_exhausted'`);
    expect(db.queries[0]?.sql).toContain(`cc.event_type = 'contribution_cap_cleared'`);
    expect(db.queries[0]?.sql).toContain(`claude_five_hour_cap_exhaustion_cycles_observed`);
    expect(db.queries[0]?.sql).toContain(`claude_seven_day_avg_usage_units_before_cap_exhaustion`);
  });

  it('falls back to null reserve fields when contribution-cap columns are missing', async () => {
    const db = new SequenceSqlClient([
      Object.assign(new Error('column "five_hour_reserve_percent" does not exist'), {
        code: '42703',
        column: 'five_hour_reserve_percent'
      }),
      { rows: [], rowCount: 0 }
    ]);
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '24h', provider: 'anthropic' });

    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]?.sql).toContain(`null::integer as five_hour_reserve_percent`);
    expect(db.queries[1]?.sql).toContain(`null::integer as seven_day_reserve_percent`);
    expect(db.queries[1]?.sql).toContain(`from in_token_credential_provider_usage pu`);
  });

  it('falls back to null provider-usage fields when the snapshot table is missing', async () => {
    const db = new SequenceSqlClient([
      Object.assign(new Error('relation "in_token_credential_provider_usage" does not exist'), {
        code: '42P01',
        relation: 'in_token_credential_provider_usage'
      }),
      { rows: [], rowCount: 0 }
    ]);
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '24h', provider: 'anthropic' });

    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]?.sql).not.toContain(`from in_token_credential_provider_usage pu`);
    expect(db.queries[1]?.sql).toContain(`null::numeric as five_hour_utilization_ratio`);
    expect(db.queries[1]?.sql).toContain(`null::timestamptz as provider_usage_fetched_at`);
  });

  it('supports 5h windows and 5m bucketed token timeseries', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTimeSeries({ window: '5h', granularity: '5m', provider: 'openai' });

    expect(db.queries[0]?.sql).toContain("re.created_at >= now() - interval '5 hours'");
    expect(db.queries[0]?.sql).toContain("to_timestamp(floor(extract(epoch from re.created_at) / 300) * 300)");
    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[0]?.params).toEqual(['openai']);
  });

  it('builds buyer inventory analytics from all buyer_proxy keys including zero-usage rows', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getBuyers({ window: '24h', provider: 'openai', source: 'direct' });

    expect(db.queries[0]?.sql).toContain("FROM in_api_keys ak");
    expect(db.queries[0]?.sql).toContain("WHERE ak.scope = 'buyer_proxy'");
    expect(db.queries[0]?.sql).toContain('LEFT JOIN in_orgs o ON o.id = ak.org_id');
    expect(db.queries[0]?.sql).toContain('LEFT JOIN buyer_rollups br ON br.api_key_id = bi.id');
    expect(db.queries[0]?.sql).toContain("coalesce(bi.preferred_provider, $1::text) AS effective_provider");
    expect(db.queries[0]?.sql).toContain("nullif(re.route_decision->>'request_source', '')");
    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
  });

  it('builds buyer timeseries with api_key_id filters and 15m buckets', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getBuyerTimeSeries({
      window: '24h',
      granularity: '15m',
      apiKeyIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    });

    expect(db.queries[0]?.sql).toContain("to_timestamp(floor(extract(epoch from re.created_at) / 900) * 900)");
    expect(db.queries[0]?.sql).toContain('re.api_key_id = ANY($1::uuid[])');
    expect(db.queries[0]?.sql).toContain('GROUP BY');
    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
    expect(db.queries[0]?.params).toEqual([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]);
  });

  it('reads recent-request usage from canonical usage ledger rows only', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getRecentRequests({ window: '24h', limit: 25 });

    expect(db.queries[0]?.sql).toContain("AND ul.entry_type = 'usage'");
  });

  it('reads lifecycle events with window/provider filters and limits', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getEvents({ window: '5h', provider: 'openai', limit: 20 });

    expect(db.queries[0]?.sql).toContain("tce.created_at >= now() - interval '5 hours'");
    expect(db.queries[0]?.sql).toContain('LEFT JOIN in_token_credentials tc');
    expect(db.queries[0]?.sql).toContain("WHEN tce.event_type in ('reactivated', 'contribution_cap_cleared') THEN 'info'");
    expect(db.queries[0]?.sql).toContain("WHEN tce.event_type = 'contribution_cap_exhausted'");
    expect(db.queries[0]?.sql).toContain('LIMIT $2');
    expect(db.queries[0]?.params).toEqual(['openai', 20]);
  });
});
