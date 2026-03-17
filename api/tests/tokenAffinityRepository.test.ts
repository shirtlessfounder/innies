import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { TokenAffinityRepository } from '../src/repos/tokenAffinityRepository.js';

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];
  transactionCount = 0;

  constructor(private readonly results: Array<SqlQueryResult | Error>) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.results.shift() ?? { rows: [], rowCount: 0 };
    if (next instanceof Error) {
      throw next;
    }
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return run(this);
  }
}

describe('tokenAffinityRepository', () => {
  it('gets preferred assignment by session id', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credential_id: '00000000-0000-0000-0000-0000000000c1',
        session_id: 'sess_1',
        last_activity_at: '2026-03-16T00:00:00Z',
        grace_expires_at: '2026-03-16T00:00:05Z',
        created_at: '2026-03-16T00:00:00Z',
        updated_at: '2026-03-16T00:00:01Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenAffinityRepository(db);

    const assignment = await repo.getPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1'
    });

    expect(assignment).toEqual({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      sessionId: 'sess_1',
      lastActivityAt: new Date('2026-03-16T00:00:00Z'),
      graceExpiresAt: new Date('2026-03-16T00:00:05Z'),
      createdAt: new Date('2026-03-16T00:00:00Z'),
      updatedAt: new Date('2026-03-16T00:00:01Z')
    });
    expect(db.queries[0].sql).toContain('from in_token_affinity_assignments');
    expect(db.queries[0].sql).toContain('session_id = $3');
  });

  it('claims one preferred credential per (org_id, provider, session_id)', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credential_id: '00000000-0000-0000-0000-0000000000c1',
        session_id: 'sess_1',
        last_activity_at: '2026-03-16T00:00:00Z',
        grace_expires_at: null,
        created_at: '2026-03-16T00:00:00Z',
        updated_at: '2026-03-16T00:00:00Z'
      }],
      rowCount: 1
    }]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1'
    });

    expect(result).toEqual({
      outcome: 'claimed',
      assignment: {
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credentialId: '00000000-0000-0000-0000-0000000000c1',
        sessionId: 'sess_1',
        lastActivityAt: new Date('2026-03-16T00:00:00Z'),
        graceExpiresAt: null,
        createdAt: new Date('2026-03-16T00:00:00Z'),
        updatedAt: new Date('2026-03-16T00:00:00Z')
      }
    });
    expect(db.transactionCount).toBe(1);
    expect(db.queries[0].sql).toContain('insert into in_token_affinity_assignments');
    expect(db.queries[0].sql).toContain('on conflict do nothing');
  });

  it('returns already_owned_by_session when the session already owns the credential', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          credential_id: '00000000-0000-0000-0000-0000000000c1',
          session_id: 'sess_1',
          last_activity_at: '2026-03-16T00:00:00Z',
          grace_expires_at: null,
          created_at: '2026-03-16T00:00:00Z',
          updated_at: '2026-03-16T00:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1'
    });

    expect(result).toEqual({
      outcome: 'already_owned_by_session',
      assignment: {
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credentialId: '00000000-0000-0000-0000-0000000000c1',
        sessionId: 'sess_1',
        lastActivityAt: new Date('2026-03-16T00:00:00Z'),
        graceExpiresAt: null,
        createdAt: new Date('2026-03-16T00:00:00Z'),
        updatedAt: new Date('2026-03-16T00:00:00Z')
      }
    });
    expect(db.queries[1].sql).toContain('session_id = $3 or credential_id = $4::uuid');
  });

  it('returns session_already_bound when the session already prefers another credential', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          credential_id: '00000000-0000-0000-0000-0000000000c2',
          session_id: 'sess_1',
          last_activity_at: '2026-03-16T00:00:00Z',
          grace_expires_at: '2026-03-16T00:00:05Z',
          created_at: '2026-03-16T00:00:00Z',
          updated_at: '2026-03-16T00:00:02Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1'
    });

    expect(result).toEqual({
      outcome: 'session_already_bound',
      assignment: {
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credentialId: '00000000-0000-0000-0000-0000000000c2',
        sessionId: 'sess_1',
        lastActivityAt: new Date('2026-03-16T00:00:00Z'),
        graceExpiresAt: new Date('2026-03-16T00:00:05Z'),
        createdAt: new Date('2026-03-16T00:00:00Z'),
        updatedAt: new Date('2026-03-16T00:00:02Z')
      }
    });
  });

  it('rejects competing claims for the same credential', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      {
        rows: [{
          org_id: '00000000-0000-0000-0000-000000000001',
          provider: 'openai',
          credential_id: '00000000-0000-0000-0000-0000000000c1',
          session_id: 'sess_other',
          last_activity_at: '2026-03-16T00:00:00Z',
          grace_expires_at: null,
          created_at: '2026-03-16T00:00:00Z',
          updated_at: '2026-03-16T00:00:00Z'
        }],
        rowCount: 1
      }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1'
    });

    expect(result).toEqual({ outcome: 'credential_unavailable' });
  });

  it('touches and clears preferred assignments explicitly', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 }
    ]);
    const repo = new TokenAffinityRepository(db);

    await repo.touchPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      graceExpiresAt: new Date('2026-03-16T00:00:05Z')
    });
    await repo.clearPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_1',
      credentialId: '00000000-0000-0000-0000-0000000000c1'
    });

    expect(db.queries[0].sql).toContain('update in_token_affinity_assignments');
    expect(db.queries[0].sql).toContain('grace_expires_at = $5');
    expect(db.queries[1].sql).toContain('delete from in_token_affinity_assignments');
    expect(db.queries[1].sql).toContain('credential_id = $4::uuid');
  });

  it('upserts active stream state for a request id', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        request_id: 'req_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credential_id: '00000000-0000-0000-0000-0000000000c1',
        session_id: 'sess_1',
        started_at: '2026-03-16T00:00:00Z',
        last_touched_at: '2026-03-16T00:00:00Z',
        ended_at: null
      }],
      rowCount: 1
    }]);
    const repo = new TokenAffinityRepository(db);

    const activeStream = await repo.upsertActiveStream({
      requestId: 'req_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      sessionId: 'sess_1'
    });

    expect(activeStream).toEqual({
      requestId: 'req_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      sessionId: 'sess_1',
      startedAt: new Date('2026-03-16T00:00:00Z'),
      lastTouchedAt: new Date('2026-03-16T00:00:00Z'),
      endedAt: null
    });
    expect(db.queries[0].sql).toContain('insert into in_token_affinity_active_streams');
    expect(db.queries[0].sql).toContain('on conflict (request_id)');
    expect(db.queries[0].sql).toContain('ended_at = null');
  });

  it('refreshes last_touched_at for a live stream heartbeat', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const touched = await repo.touchActiveStream({
      requestId: 'req_1',
      touchedAt: new Date('2026-03-16T00:00:10Z')
    });

    expect(touched).toBe(true);
    expect(db.queries[0].sql).toContain('update in_token_affinity_active_streams');
    expect(db.queries[0].sql).toContain('last_touched_at = $2');
    expect(db.queries[0].sql).toContain('ended_at is null');
  });

  it('returns cleared stream context by request id', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        request_id: 'req_1',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credential_id: '00000000-0000-0000-0000-0000000000c1',
        session_id: 'sess_1',
        started_at: '2026-03-16T00:00:00Z',
        last_touched_at: '2026-03-16T00:00:10Z',
        ended_at: null
      }],
      rowCount: 1
    }]);
    const repo = new TokenAffinityRepository(db);

    const cleared = await repo.clearActiveStream({ requestId: 'req_1' });

    expect(cleared).toEqual({
      requestId: 'req_1',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      sessionId: 'sess_1',
      startedAt: new Date('2026-03-16T00:00:00Z'),
      lastTouchedAt: new Date('2026-03-16T00:00:10Z'),
      endedAt: null
    });
    expect(db.queries[0].sql).toContain('delete from in_token_affinity_active_streams');
    expect(db.queries[0].sql).toContain('returning');
  });

  it('lists busy credential ids from active-stream rows', async () => {
    const db = new SequenceSqlClient([{
      rows: [
        { credential_id: '00000000-0000-0000-0000-0000000000c1' },
        { credential_id: '00000000-0000-0000-0000-0000000000c2' }
      ],
      rowCount: 2
    }]);
    const repo = new TokenAffinityRepository(db);

    const credentialIds = await repo.listBusyCredentialIds({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      staleBefore: new Date('2026-03-16T00:00:30Z')
    });

    expect(credentialIds).toEqual([
      '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c2'
    ]);
    expect(db.queries[0].sql).toContain('select distinct credential_id');
    expect(db.queries[0].sql).toContain('last_touched_at >= $3');
    expect(db.queries[0].sql).toContain('ended_at is null');
  });

  it('clears stale active streams and orphaned preferred ownership together', async () => {
    const db = new SequenceSqlClient([{
      rows: [{
        request_id: 'req_stale',
        org_id: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credential_id: '00000000-0000-0000-0000-0000000000c1',
        session_id: 'sess_1',
        started_at: '2026-03-16T00:00:00Z',
        last_touched_at: '2026-03-16T00:00:10Z',
        ended_at: null
      }],
      rowCount: 1
    }]);
    const repo = new TokenAffinityRepository(db);

    const cleared = await repo.clearStaleActiveStreams({
      staleBefore: new Date('2026-03-16T00:00:30Z')
    });

    expect(cleared).toEqual([{
      requestId: 'req_stale',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-0000000000c1',
      sessionId: 'sess_1',
      startedAt: new Date('2026-03-16T00:00:00Z'),
      lastTouchedAt: new Date('2026-03-16T00:00:10Z'),
      endedAt: null
    }]);
    expect(db.queries[0].sql).toContain('delete from in_token_affinity_active_streams');
    expect(db.queries[0].sql).toContain('delete from in_token_affinity_assignments');
    expect(db.queries[0].sql).toContain('last_touched_at < $1');
  });
});
