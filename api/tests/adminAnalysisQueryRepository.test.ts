import { describe, expect, it } from 'vitest';
import { AdminAnalysisQueryRepository } from '../src/repos/adminAnalysisQueryRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

describe('AdminAnalysisQueryRepository', () => {
  it('builds the overview query from analysis request and session tables with approved filters', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ total_requests: '12', total_tokens: '3400' }], rowCount: 1 },
      { rows: [{ total_sessions: '5' }], rowCount: 1 },
      { rows: [{ task_category: 'debugging', count: '7' }], rowCount: 1 },
      { rows: [{ tag: 'postgres', count: '4' }], rowCount: 1 },
      { rows: [{ retry_count: '2', failure_count: '1' }], rowCount: 1 }
    ]);
    const repo = new AdminAnalysisQueryRepository(db);

    const result = await repo.getOverview({
      start: new Date('2026-03-24T00:00:00Z'),
      end: new Date('2026-03-31T00:00:00Z'),
      orgId: 'org_1',
      sessionType: 'openclaw',
      provider: 'openai',
      source: 'openclaw',
      taskCategory: 'debugging',
      taskTag: 'postgres'
    });

    expect(result.totals.totalRequests).toBe(12);
    expect(result.categoryMix).toEqual([{ taskCategory: 'debugging', count: 7 }]);
    expect(db.queries[0]?.sql).toContain('from in_admin_analysis_requests');
    expect(db.queries[0]?.sql).toContain('started_at >= $1');
    expect(db.queries[0]?.sql).toContain('session_type = $');
    expect(db.queries[0]?.sql).toContain('provider = $');
    expect(db.queries[0]?.sql).toContain('source = $');
    expect(db.queries[0]?.sql).toContain('task_category = $');
    expect(db.queries[0]?.sql).toContain('task_tags @> array[');
    expect(db.queries[1]?.sql).toContain('from in_admin_analysis_sessions');
  });

  it('builds UTC day-bucket category trend queries', async () => {
    const db = new MockSqlClient({
      rows: [{
        day: '2026-03-31',
        task_category: 'debugging',
        count: '3'
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisQueryRepository(db);

    const rows = await repo.getCategoryTrends({
      start: new Date('2026-03-24T00:00:00Z'),
      end: new Date('2026-03-31T00:00:00Z'),
      provider: 'openai'
    });

    expect(rows).toEqual([{ day: '2026-03-31', taskCategory: 'debugging', count: 3 }]);
    expect(db.queries[0]?.sql).toContain("(started_at at time zone 'utc')::date as day");
    expect(db.queries[0]?.sql).toContain('group by day, task_category');
  });

  it('builds tag trend queries from unnested task tags', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ tag: 'postgres', count: '4' }], rowCount: 1 },
      { rows: [{ tag: 'postgres', co_tag: 'migration', count: '3' }], rowCount: 1 }
    ]);
    const repo = new AdminAnalysisQueryRepository(db);

    const result = await repo.getTagTrends({
      start: new Date('2026-03-24T00:00:00Z'),
      end: new Date('2026-03-31T00:00:00Z'),
      taskCategory: 'debugging'
    });

    expect(result.topTags).toEqual([{ tag: 'postgres', count: 4 }]);
    expect(result.cooccurringTags).toEqual([{ tag: 'postgres', coTag: 'migration', count: 3 }]);
    expect(db.queries[0]?.sql).toContain('cross join unnest(task_tags) as tag');
    expect(db.queries[1]?.sql).toContain('left join lateral unnest(r2.task_tags)');
  });

  it('builds interesting-signal totals from mechanical booleans', async () => {
    const db = new MockSqlClient({
      rows: [{
        retry_count: '2',
        failure_count: '1',
        partial_count: '1',
        high_token_count: '4',
        cross_provider_rescue_count: '1',
        tool_use_count: '5',
        long_session_count: '2',
        high_token_session_count: '1',
        retry_heavy_session_count: '1',
        cross_provider_session_count: '1',
        multi_model_session_count: '1'
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisQueryRepository(db);

    const result = await repo.getInterestingSignals({
      start: new Date('2026-03-24T00:00:00Z'),
      end: new Date('2026-03-31T00:00:00Z')
    });

    expect(result.retryCount).toBe(2);
    expect(result.longSessionCount).toBe(2);
    expect(db.queries[0]?.sql).toContain('sum(case when is_retry then 1 else 0 end) as retry_count');
    expect(db.queries[0]?.sql).toContain('sum(case when is_long_session then 1 else 0 end) as long_session_count');
  });

  it('builds stratified request and session sample queries instead of latest-n feeds', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ request_attempt_archive_id: 'archive_1' }], rowCount: 1 },
      { rows: [{ session_key: 'openclaw:session:sess_1' }], rowCount: 1 }
    ]);
    const repo = new AdminAnalysisQueryRepository(db);

    await repo.listRequestSamples({
      start: new Date('2026-03-31T00:00:00Z'),
      end: new Date('2026-04-01T00:00:00Z'),
      sampleSize: 10
    });
    await repo.listSessionSamples({
      start: new Date('2026-03-31T00:00:00Z'),
      end: new Date('2026-04-01T00:00:00Z'),
      sampleSize: 10
    });

    expect(db.queries[0]?.sql).toContain('row_number() over (partition by');
    expect(db.queries[0]?.sql).toContain('date_trunc(\'hour\', started_at)');
    expect(db.queries[0]?.sql).toContain('task_category');
    expect(db.queries[0]?.sql).toContain('where bucket_rank = 1');
    expect(db.queries[1]?.sql).toContain('date_trunc(\'hour\', last_activity_at)');
    expect(db.queries[1]?.sql).toContain('primary_task_category');
  });

  it('loads request detail, session detail, and coverage metadata from analysis tables', async () => {
    const db = new SequenceSqlClient([
      { rows: [{ request_id: 'req_1', attempt_no: 2, session_key: 'openclaw:session:sess_1' }], rowCount: 1 },
      { rows: [{ session_key: 'openclaw:session:sess_1', primary_task_category: 'debugging' }], rowCount: 1 },
      { rows: [{ projected_request_count: '42', pending_projection_count: '3', first_projected_at: '2026-03-24T00:00:00Z', last_projected_at: '2026-03-31T00:00:00Z' }], rowCount: 1 }
    ]);
    const repo = new AdminAnalysisQueryRepository(db);

    const request = await repo.getRequestDetail('req_1', 2);
    const session = await repo.getSessionDetail('openclaw:session:sess_1');
    const coverage = await repo.getCoverage({
      start: new Date('2026-03-24T00:00:00Z'),
      end: new Date('2026-03-31T00:00:00Z')
    });

    expect(request?.requestId).toBe('req_1');
    expect(session?.sessionKey).toBe('openclaw:session:sess_1');
    expect(coverage.projectedRequestCount).toBe(42);
    expect(coverage.pendingProjectionCount).toBe(3);
    expect(db.queries[0]?.sql).toContain('where request_id = $1');
    expect(db.queries[1]?.sql).toContain('where session_key = $1');
    expect(db.queries[2]?.sql).toContain('from in_admin_analysis_requests r');
    expect(db.queries[2]?.sql).toContain('left join in_admin_analysis_request_projection_outbox o');
  });
});
