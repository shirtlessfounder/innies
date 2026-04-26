import { describe, expect, it } from 'vitest';
import { AdminAnalysisRequestRepository } from '../src/repos/adminAnalysisRequestRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const sampleRequest = {
  requestAttemptArchiveId: 'archive_1',
  requestId: 'req_1',
  attemptNo: 1,
  sessionKey: 'openclaw:session:sess_1',
  orgId: 'org_1',
  apiKeyId: 'api_1',
  sessionType: 'openclaw' as const,
  groupingBasis: 'explicit_session_id' as const,
  source: 'openclaw',
  provider: 'openai',
  model: 'gpt-5.4',
  status: 'success' as const,
  startedAt: new Date('2026-03-31T22:00:00Z'),
  completedAt: new Date('2026-03-31T22:00:05Z'),
  inputTokens: 120,
  outputTokens: 240,
  userMessagePreview: 'ship this endpoint',
  assistantTextPreview: 'implemented',
  taskCategory: 'feature_building' as const,
  taskTags: ['typescript', 'api'],
  isRetry: false,
  isFailure: false,
  isPartial: false,
  isHighToken: false,
  isCrossProviderRescue: false,
  hasToolUse: true,
  interestingnessScore: 18
};

describe('AdminAnalysisRequestRepository', () => {
  it('upserts request analysis rows by archived attempt id', async () => {
    const db = new MockSqlClient({
      rows: [{
        request_attempt_archive_id: sampleRequest.requestAttemptArchiveId,
        session_key: sampleRequest.sessionKey
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisRequestRepository(db);

    const row = await repo.upsertRequest(sampleRequest);

    expect(row).toEqual(expect.objectContaining({
      request_attempt_archive_id: sampleRequest.requestAttemptArchiveId,
      session_key: sampleRequest.sessionKey
    }));
    expect(db.queries[0].sql).toContain('insert into in_admin_analysis_requests');
    expect(db.queries[0].sql).toContain('on conflict (request_attempt_archive_id)');
    expect(db.queries[0].sql).toContain('task_category = excluded.task_category');
  });

  it('loads one row by archive id and lists rows by session key in stable order', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [{
          request_attempt_archive_id: sampleRequest.requestAttemptArchiveId
        }],
        rowCount: 1
      },
      {
        rows: [
          { request_attempt_archive_id: 'archive_1', started_at: '2026-03-31T22:00:00Z', request_id: 'req_1', attempt_no: 1 },
          { request_attempt_archive_id: 'archive_2', started_at: '2026-03-31T22:01:00Z', request_id: 'req_2', attempt_no: 1 }
        ],
        rowCount: 2
      }
    ]);
    const repo = new AdminAnalysisRequestRepository(db);

    const found = await repo.findByArchiveId(sampleRequest.requestAttemptArchiveId);
    const rows = await repo.listBySessionKey(sampleRequest.sessionKey);

    expect(found).toEqual(expect.objectContaining({
      request_attempt_archive_id: sampleRequest.requestAttemptArchiveId
    }));
    expect(rows).toHaveLength(2);
    expect(db.queries[0].sql).toContain('where request_attempt_archive_id = $1');
    expect(db.queries[1].sql).toContain('where session_key = $1');
    expect(db.queries[1].sql).toContain('order by started_at asc, request_id asc, attempt_no asc');
  });

  it('returns null when an archive lookup misses', async () => {
    const db = new MockSqlClient({
      rows: [],
      rowCount: 0
    });
    const repo = new AdminAnalysisRequestRepository(db);

    await expect(repo.findByArchiveId('missing')).resolves.toBeNull();
  });

  it('loads session analysis rollup as one aggregate row', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: sampleRequest.sessionKey,
        request_count: 2,
        attempt_count: 3,
        primary_task_category: 'feature_building'
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisRequestRepository(db);

    const row = await repo.loadSessionRollup(sampleRequest.sessionKey);

    expect(row).toEqual(expect.objectContaining({
      session_key: sampleRequest.sessionKey,
      request_count: 2,
      attempt_count: 3
    }));
    expect(db.queries[0].sql).toContain('with scoped as');
    expect(db.queries[0].sql).toContain('where session_key = $1');
    expect(db.queries[0].sql).toContain('jsonb_object_agg(task_category, request_count)');
    expect(db.queries[0].params).toEqual([sampleRequest.sessionKey]);
  });
});
