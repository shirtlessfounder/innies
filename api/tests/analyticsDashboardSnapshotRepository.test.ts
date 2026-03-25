import { describe, expect, it, vi } from 'vitest';
import { AnalyticsDashboardSnapshotRepository } from '../src/repos/analyticsDashboardSnapshotRepository.js';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

  constructor(private readonly results: SqlQueryResult[]) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.results.shift();
    if (!next) {
      throw new Error('unexpected query');
    }
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

describe('AnalyticsDashboardSnapshotRepository', () => {
  it('returns null when no cached snapshot exists', async () => {
    const sql = new SequenceSqlClient([{ rows: [], rowCount: 0 }]);
    const repo = new AnalyticsDashboardSnapshotRepository(sql);

    await expect(repo.get({ window: '24h', provider: 'openai' })).resolves.toBeNull();
  });

  it('does not build a snapshot when another process already owns the refresh lock', async () => {
    const sql = new SequenceSqlClient([
      { rows: [{ locked: false }], rowCount: 1 }
    ]);
    const repo = new AnalyticsDashboardSnapshotRepository(sql);
    const buildPayload = vi.fn();

    await expect(repo.refreshIfLockAvailable({ window: '24h' }, buildPayload)).resolves.toBeNull();
    expect(buildPayload).not.toHaveBeenCalled();
  });

  it('stores and returns a refreshed snapshot when the advisory lock is acquired', async () => {
    const sql = new SequenceSqlClient([
      { rows: [{ locked: true }], rowCount: 1 },
      {
        rows: [{
          cache_key: 'dashboard:v5:24h:openai:_:_',
          dashboard_window: '24h',
          provider: 'openai',
          source: null,
          payload: {
            window: '24h',
            snapshotAt: '2026-03-12T12:00:00.000Z',
            summary: { totalRequests: 1 },
            tokens: [],
            buyers: [],
            anomalies: { checks: {}, ok: true },
            events: []
          },
          snapshot_at: new Date('2026-03-12T12:00:00.000Z'),
          refreshed_at: new Date('2026-03-12T12:00:01.000Z')
        }],
        rowCount: 1
      }
    ]);
    const repo = new AnalyticsDashboardSnapshotRepository(sql);
    const buildPayload = vi.fn().mockResolvedValue({
      window: '24h',
      snapshotAt: '2026-03-12T12:00:00.000Z',
      summary: { totalRequests: 1 },
      tokens: [],
      buyers: [],
      anomalies: { checks: {}, ok: true },
      events: []
    });

    const snapshot = await repo.refreshIfLockAvailable(
      { window: '24h', provider: 'openai' },
      buildPayload
    );

    expect(buildPayload).toHaveBeenCalledTimes(1);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[0].sql).toContain('pg_try_advisory_xact_lock');
    expect(sql.queries[1].sql).toContain('insert into in_analytics_dashboard_snapshots');
    expect(sql.queries[0].params?.[1]).toBe('dashboard:v5:24h:openai:_:_');
    expect(snapshot).toEqual({
      cacheKey: 'dashboard:v5:24h:openai:_:_',
      window: '24h',
      provider: 'openai',
      source: undefined,
      payload: {
        window: '24h',
        snapshotAt: '2026-03-12T12:00:00.000Z',
        summary: { totalRequests: 1 },
        tokens: [],
        buyers: [],
        anomalies: { checks: {}, ok: true },
        events: []
      },
      snapshotAt: new Date('2026-03-12T12:00:00.000Z'),
      refreshedAt: new Date('2026-03-12T12:00:01.000Z')
    });
  });

  it('includes orgId in the cache key for org-scoped dashboard snapshots', async () => {
    const sql = new SequenceSqlClient([
      { rows: [{ locked: true }], rowCount: 1 },
      {
        rows: [{
          cache_key: 'dashboard:v5:24h:openai:_:org_1',
          dashboard_window: '24h',
          provider: 'openai',
          source: null,
          payload: {
            window: '24h',
            snapshotAt: '2026-03-12T12:00:00.000Z',
            summary: { totalRequests: 1 },
            tokens: [],
            buyers: [],
            anomalies: { checks: {}, ok: true },
            events: []
          },
          snapshot_at: new Date('2026-03-12T12:00:00.000Z'),
          refreshed_at: new Date('2026-03-12T12:00:01.000Z')
        }],
        rowCount: 1
      }
    ]);
    const repo = new AnalyticsDashboardSnapshotRepository(sql);

    await repo.refreshIfLockAvailable(
      { window: '24h', provider: 'openai', orgId: 'org_1' },
      async () => ({
        window: '24h',
        snapshotAt: '2026-03-12T12:00:00.000Z',
        summary: { totalRequests: 1 },
        tokens: [],
        buyers: [],
        anomalies: { checks: {}, ok: true },
        events: []
      })
    );

    expect(sql.queries[0].params?.[1]).toBe('dashboard:v5:24h:openai:_:org_1');
  });
});
