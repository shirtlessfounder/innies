import { describe, expect, it } from 'vitest';
import { AnalyticsRepository } from '../src/repos/analyticsRepository.js';
import { MockSqlClient } from './testHelpers.js';

class SequencedMockSqlClient extends MockSqlClient {
  constructor(private readonly results: Array<{ rows: unknown[]; rowCount: number }>) {
    super({ rows: [], rowCount: 0 });
  }

  override async query(sql: string, params?: unknown[]) {
    this.queries.push({ sql, params: params as any });
    return (this.results.shift() ?? { rows: [], rowCount: 0 }) as any;
  }
}

describe('AnalyticsRepository anomalies', () => {
  it('builds aggregate anomaly checks from raw freshness and ignores source filters for those queries', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getAnomalies({ window: '7d', provider: 'openai', source: 'direct' });

    expect(db.queries).toHaveLength(5);

    expect(db.queries[1]?.params).toEqual(['openai', 'direct']);
    expect(db.queries[2]?.params).toEqual(['openai', 'direct']);

    expect(db.queries[3]?.sql).toContain("ul.entry_type = 'usage'");
    expect(db.queries[3]?.sql).toContain('LEFT JOIN in_daily_aggregates da');
    expect(db.queries[3]?.sql).toContain("(ul.created_at at time zone 'utc')::date");
    expect(db.queries[3]?.sql).toContain("rw.latest_raw_at + interval '20 minutes'");
    expect(db.queries[3]?.sql).toContain('now() >= refresh_due_at');
    expect(db.queries[3]?.sql).toContain('updated_at < latest_raw_at');
    expect(db.queries[3]?.sql).not.toContain("updated_at IS NOT NULL AND updated_at < now() - interval '20 minutes'");
    expect(db.queries[3]?.sql).not.toContain("request_source");
    expect(db.queries[3]?.params).toEqual(['openai']);

    expect(db.queries[4]?.sql).toContain("ul.entry_type = 'usage'");
    expect(db.queries[4]?.sql).toContain('UNION');
    expect(db.queries[4]?.sql).toContain('SELECT DISTINCT da.day');
    expect(db.queries[4]?.sql).toContain("(ul.created_at at time zone 'utc')::date");
    expect(db.queries[4]?.sql).toContain("da.day >= ((now() at time zone 'utc') - interval '7 days')::date");
    expect(db.queries[4]?.sql).toContain('FULL OUTER JOIN aggregate_windows aw');
    expect(db.queries[4]?.sql).toContain("WHERE day < (now() at time zone 'utc')::date");
    expect(db.queries[4]?.sql).not.toContain("request_source");
    expect(db.queries[4]?.params).toEqual(['openai']);
  });

  it('returns real stale and mismatch anomaly counts and marks ok false', async () => {
    const db = new SequencedMockSqlClient([
      { rows: [{ cnt: 0 }], rowCount: 1 },
      { rows: [{ cnt: 0 }], rowCount: 1 },
      { rows: [{ cnt: 0 }], rowCount: 1 },
      { rows: [{ cnt: 2 }], rowCount: 1 },
      { rows: [{ cnt: 1 }], rowCount: 1 }
    ]);
    const repo = new AnalyticsRepository(db as any);

    const result = await repo.getAnomalies({ window: '24h', provider: 'anthropic', source: 'openclaw' }) as any;

    expect(result).toEqual({
      checks: {
        missing_debug_labels: 0,
        unresolved_credential_ids_in_token_mode_usage: 0,
        null_credential_ids_in_routing: 0,
        stale_aggregate_windows: 2,
        usage_ledger_vs_aggregate_mismatch_count: 1
      },
      ok: false
    });
  });
});
