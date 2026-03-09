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
    expect(db.queries[2]?.sql).toContain("AND provider = $1");
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

  it('keeps health utilization deferred instead of dividing by monthly contribution limit', async () => {
    const db = new MockSqlClient({ rows: [], rowCount: 0 });
    const repo = new AnalyticsRepository(db);

    await repo.getTokenHealth({ window: '7d', provider: 'anthropic' });

    expect(db.queries[0]?.sql).toContain('NULL AS utilization_rate_24h');
  });
});
