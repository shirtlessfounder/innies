import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../src/repos/analyticsRepository.js';
import { MockSqlClient } from './testHelpers.js';

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
    expect(db.queries[0]?.sql).toContain("WHEN tce.event_type = 'reactivated' THEN 'info'");
    expect(db.queries[0]?.sql).toContain('LIMIT $2');
    expect(db.queries[0]?.params).toEqual(['openai', 20]);
  });
});
