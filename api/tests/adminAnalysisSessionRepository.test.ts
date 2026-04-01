import { describe, expect, it } from 'vitest';
import { AdminAnalysisSessionRepository } from '../src/repos/adminAnalysisSessionRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const sampleSession = {
  sessionKey: 'openclaw:session:sess_1',
  orgId: 'org_1',
  sessionType: 'openclaw' as const,
  groupingBasis: 'explicit_session_id' as const,
  startedAt: new Date('2026-03-31T22:00:00Z'),
  endedAt: new Date('2026-03-31T22:45:00Z'),
  lastActivityAt: new Date('2026-03-31T22:45:00Z'),
  requestCount: 9,
  attemptCount: 11,
  inputTokens: 3200,
  outputTokens: 5100,
  primaryTaskCategory: 'debugging' as const,
  taskCategoryBreakdown: { debugging: 6, feature_building: 3 },
  taskTagSet: ['typescript', 'postgres', 'sse'],
  isLongSession: true,
  isHighTokenSession: true,
  isRetryHeavySession: false,
  isCrossProviderSession: true,
  isMultiModelSession: true,
  interestingnessScore: 39
};

describe('AdminAnalysisSessionRepository', () => {
  it('upserts session analysis rows by session key', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: sampleSession.sessionKey,
        primary_task_category: sampleSession.primaryTaskCategory
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisSessionRepository(db);

    const row = await repo.upsertSession(sampleSession);

    expect(row).toEqual(expect.objectContaining({ session_key: sampleSession.sessionKey }));
    expect(db.queries[0].sql).toContain('insert into in_admin_analysis_sessions');
    expect(db.queries[0].sql).toContain('on conflict (session_key)');
    expect(db.queries[0].sql).toContain('task_tag_set = excluded.task_tag_set');
  });

  it('loads one row by session key', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: sampleSession.sessionKey
      }],
      rowCount: 1
    });
    const repo = new AdminAnalysisSessionRepository(db);

    const row = await repo.findBySessionKey(sampleSession.sessionKey);

    expect(row).toEqual(expect.objectContaining({ session_key: sampleSession.sessionKey }));
    expect(db.queries[0].sql).toContain('where session_key = $1');
  });

  it('returns null when a session lookup misses', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 }
    ]);
    const repo = new AdminAnalysisSessionRepository(db);

    await expect(repo.findBySessionKey('missing')).resolves.toBeNull();
  });
});
