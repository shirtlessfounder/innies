import { describe, expect, it } from 'vitest';
import { AdminSessionRepository } from '../src/repos/adminSessionRepository.js';
import { MockSqlClient, SequenceSqlClient } from './testHelpers.js';

const sampleSession = {
  sessionKey: 'cli:idle:org_1:api_1:req_1',
  sessionType: 'cli' as const,
  groupingBasis: 'idle_gap' as const,
  orgId: 'org_1',
  apiKeyId: 'api_1',
  sourceSessionId: null,
  sourceRunId: 'run_1',
  startedAt: new Date('2026-03-31T22:00:00Z'),
  endedAt: new Date('2026-03-31T22:01:00Z'),
  lastActivityAt: new Date('2026-03-31T22:01:00Z'),
  requestCount: 1,
  attemptCount: 2,
  inputTokens: 120,
  outputTokens: 240,
  providerSet: ['anthropic'],
  modelSet: ['claude-opus-4-1'],
  statusSummary: { success: 1, failed: 1 },
  previewSample: { requestText: 'hello', responseText: 'world' }
};

describe('AdminSessionRepository', () => {
  it('upserts sessions by session key', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: sampleSession.sessionKey,
        session_type: sampleSession.sessionType
      }],
      rowCount: 1
    });
    const repo = new AdminSessionRepository(db);

    const row = await repo.upsertSession(sampleSession);

    expect(row).toEqual(expect.objectContaining({ session_key: sampleSession.sessionKey }));
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('insert into in_admin_sessions');
    expect(db.queries[0].sql).toContain('on conflict (session_key)');
    expect(db.queries[0].sql).toContain('last_activity_at = excluded.last_activity_at');
    expect(db.queries[0].params).toContain(sampleSession.sessionKey);
    expect(db.queries[0].params).toContain('idle_gap');
  });

  it('finds the latest session in the same lane', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: 'cli:idle:org_1:api_1:req_0'
      }],
      rowCount: 1
    });
    const repo = new AdminSessionRepository(db);

    const row = await repo.findLatestInLane({
      orgId: 'org_1',
      apiKeyId: 'api_1',
      sessionType: 'cli'
    });

    expect(row).toEqual(expect.objectContaining({ session_key: 'cli:idle:org_1:api_1:req_0' }));
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('from in_admin_sessions');
    expect(db.queries[0].sql).toContain('api_key_id is not distinct from $2');
    expect(db.queries[0].sql).toContain('order by last_activity_at desc, session_key desc');
    expect(db.queries[0].params).toEqual(['org_1', 'api_1', 'cli']);
  });

  it('loads one session by session key', async () => {
    const db = new MockSqlClient({
      rows: [{
        session_key: sampleSession.sessionKey
      }],
      rowCount: 1
    });
    const repo = new AdminSessionRepository(db);

    const row = await repo.findBySessionKey(sampleSession.sessionKey);

    expect(row).toEqual(expect.objectContaining({ session_key: sampleSession.sessionKey }));
    expect(db.queries[0].sql).toContain('where session_key = $1');
  });

  it('returns null when a lane or session lookup misses', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }
    ]);
    const repo = new AdminSessionRepository(db);

    await expect(repo.findLatestInLane({
      orgId: 'org_1',
      apiKeyId: null,
      sessionType: 'openclaw'
    })).resolves.toBeNull();
    await expect(repo.findBySessionKey('missing')).resolves.toBeNull();
  });
});
