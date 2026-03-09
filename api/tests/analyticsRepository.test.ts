import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../src/repos/analyticsRepository.js';
import { MockSqlClient } from './testHelpers.js';

describe('AnalyticsRepository', () => {
  it('applies provider filters to system token inventory queries', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getSystemSummary({ window: '24h', provider: 'openai' });

    expect(db.queries[1]?.sql).toContain('FROM in_token_credentials where provider = $1');
    expect(db.queries[1]?.params).toEqual(['openai']);
    expect(db.queries[2]?.sql).toContain('AND provider = $1');
    expect(db.queries[2]?.params).toEqual(['openai']);
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
});
