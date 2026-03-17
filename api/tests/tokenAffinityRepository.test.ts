import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { PgSqlClient } from '../src/repos/pgClient.js';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { TokenAffinityRepository } from '../src/repos/tokenAffinityRepository.js';

type AssignmentRow = {
  org_id: string;
  provider: string;
  credential_id: string;
  session_id: string;
  last_activity_at: string;
  grace_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type ActiveStreamRow = {
  request_id: string;
  org_id: string;
  provider: string;
  credential_id: string;
  session_id: string;
  started_at: string;
  last_touched_at: string;
  ended_at: string | null;
};

const tokenAffinityMigrationSql = readFileSync(
  new URL('../../docs/migrations/017_token_affinity.sql', import.meta.url),
  'utf8'
);

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

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
    return run(this);
  }
}

function assignmentRow(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    org_id: '00000000-0000-0000-0000-000000000001',
    provider: 'openai',
    credential_id: '00000000-0000-0000-0000-000000000010',
    session_id: 'sess_123',
    last_activity_at: '2026-03-16T00:00:00.000Z',
    grace_expires_at: null,
    created_at: '2026-03-16T00:00:00.000Z',
    updated_at: '2026-03-16T00:00:00.000Z',
    ...overrides
  };
}

function activeStreamRow(overrides: Partial<ActiveStreamRow> = {}): ActiveStreamRow {
  return {
    request_id: 'req_123',
    org_id: '00000000-0000-0000-0000-000000000001',
    provider: 'openai',
    credential_id: '00000000-0000-0000-0000-000000000010',
    session_id: 'sess_123',
    started_at: '2026-03-16T00:00:00.000Z',
    last_touched_at: '2026-03-16T00:00:05.000Z',
    ended_at: null,
    ...overrides
  };
}

async function withContractRepository(
  run: (ctx: {
    repo: TokenAffinityRepository;
    pool: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      end: () => Promise<void>;
    };
  }) => Promise<void>
): Promise<void> {
  const memoryDb = newDb();
  memoryDb.public.none(tokenAffinityMigrationSql);

  const { Pool } = memoryDb.adapters.createPg();
  const pool = new Pool();
  const repo = new TokenAffinityRepository(new PgSqlClient(pool));

  try {
    await run({ repo, pool });
  } finally {
    await pool.end();
  }
}

describe('tokenAffinityRepository', () => {
  it('gets a preferred assignment by session', async () => {
    const db = new SequenceSqlClient([{ rows: [assignmentRow()], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const assignment = await repo.getPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123'
    });

    expect(assignment?.credentialId).toBe('00000000-0000-0000-0000-000000000010');
    expect(assignment?.sessionId).toBe('sess_123');
    expect(db.queries[0]?.sql).toContain('from in_token_affinity_assignments');
    expect(db.queries[0]?.sql).toContain('session_id = $3');
  });

  it('claims one preferred credential per (org_id, provider, session_id)', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [assignmentRow()], rowCount: 1 }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010'
    });

    expect(result).toMatchObject({
      outcome: 'claimed',
      assignment: {
        credentialId: '00000000-0000-0000-0000-000000000010',
        sessionId: 'sess_123'
      }
    });
    expect(db.queries).toHaveLength(2);
    expect(db.queries[1]?.sql).toContain('insert into in_token_affinity_assignments');
    expect(db.queries[1]?.sql).toContain('on conflict do nothing');
  });

  it('returns already_owned_by_session when the same session already owns the credential', async () => {
    const db = new SequenceSqlClient([{ rows: [assignmentRow()], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010'
    });

    expect(result).toMatchObject({
      outcome: 'already_owned_by_session',
      assignment: {
        credentialId: '00000000-0000-0000-0000-000000000010',
        sessionId: 'sess_123'
      }
    });
    expect(db.queries).toHaveLength(1);
  });

  it('returns session_already_bound when the session already owns another credential', async () => {
    const db = new SequenceSqlClient([
      {
        rows: [
          assignmentRow({
            credential_id: '00000000-0000-0000-0000-000000000011'
          })
        ],
        rowCount: 1
      }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010'
    });

    expect(result).toMatchObject({
      outcome: 'session_already_bound',
      assignment: {
        credentialId: '00000000-0000-0000-0000-000000000011',
        sessionId: 'sess_123'
      }
    });
  });

  it('rejects competing claims for the same credential', async () => {
    const db = new SequenceSqlClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      {
        rows: [
          assignmentRow({
            session_id: 'sess_other'
          })
        ],
        rowCount: 1
      }
    ]);
    const repo = new TokenAffinityRepository(db);

    const result = await repo.claimPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010'
    });

    expect(result).toEqual({ outcome: 'credential_unavailable' });
    expect(db.queries).toHaveLength(4);
    expect(db.queries[3]?.sql).toContain('credential_id = $3');
  });

  it('touches a preferred assignment grace window', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);
    const graceExpiresAt = new Date('2026-03-16T00:00:10.000Z');

    const updated = await repo.touchPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010',
      graceExpiresAt
    });

    expect(updated).toBe(true);
    expect(db.queries[0]?.sql).toContain('update in_token_affinity_assignments');
    expect(db.queries[0]?.params?.[4]).toBe(graceExpiresAt);
  });

  it('clears a preferred assignment', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const cleared = await repo.clearPreferredAssignment({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      sessionId: 'sess_123',
      credentialId: '00000000-0000-0000-0000-000000000010'
    });

    expect(cleared).toBe(true);
    expect(db.queries[0]?.sql).toContain('delete from in_token_affinity_assignments');
    expect(db.queries[0]?.sql).toContain('credential_id = $4');
  });

  it('upserts an active stream by request id', async () => {
    const db = new SequenceSqlClient([{ rows: [activeStreamRow()], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const stream = await repo.upsertActiveStream({
      requestId: 'req_123',
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      credentialId: '00000000-0000-0000-0000-000000000010',
      sessionId: 'sess_123'
    });

    expect(stream.requestId).toBe('req_123');
    expect(db.queries[0]?.sql).toContain('insert into in_token_affinity_active_streams');
    expect(db.queries[0]?.sql).toContain('on conflict (request_id)');
  });

  it('refreshes last_touched_at for a live stream heartbeat', async () => {
    const db = new SequenceSqlClient([{ rows: [], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);
    const touchedAt = new Date('2026-03-16T00:00:20.000Z');

    const touched = await repo.touchActiveStream({
      requestId: 'req_123',
      touchedAt
    });

    expect(touched).toBe(true);
    expect(db.queries[0]?.sql).toContain('update in_token_affinity_active_streams');
    expect(db.queries[0]?.sql).toContain('last_touched_at = $2');
    expect(db.queries[0]?.params).toEqual(['req_123', touchedAt]);
  });

  it('returns cleared stream context by request id', async () => {
    const db = new SequenceSqlClient([{ rows: [activeStreamRow()], rowCount: 1 }]);
    const repo = new TokenAffinityRepository(db);

    const cleared = await repo.clearActiveStream({
      requestId: 'req_123'
    });

    expect(cleared).toMatchObject({
      requestId: 'req_123',
      credentialId: '00000000-0000-0000-0000-000000000010',
      sessionId: 'sess_123'
    });
    expect(db.queries[0]?.sql).toContain('delete from in_token_affinity_active_streams');
    expect(db.queries[0]?.sql).toContain('returning');
  });

  it('lists busy credential ids for a partition', async () => {
    const db = new SequenceSqlClient([{
      rows: [
        { credential_id: '00000000-0000-0000-0000-000000000010' },
        { credential_id: '00000000-0000-0000-0000-000000000011' }
      ],
      rowCount: 2
    }]);
    const repo = new TokenAffinityRepository(db);

    const busyCredentialIds = await repo.listBusyCredentialIds({
      orgId: '00000000-0000-0000-0000-000000000001',
      provider: 'openai',
      staleBefore: new Date('2026-03-16T00:00:00.000Z')
    });

    expect(busyCredentialIds).toEqual([
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000011'
    ]);
    expect(db.queries[0]?.sql).toContain('select distinct credential_id');
    expect(db.queries[0]?.sql).toContain('last_touched_at >= $3');
  });

  it('clears stale active streams and returns the cleared rows for higher-layer cleanup', async () => {
    const db = new SequenceSqlClient([{
      rows: [
        activeStreamRow(),
        activeStreamRow({
          request_id: 'req_456',
          credential_id: '00000000-0000-0000-0000-000000000011',
          session_id: 'sess_456'
        })
      ],
      rowCount: 2
    }]);
    const repo = new TokenAffinityRepository(db);

    const cleared = await repo.clearStaleActiveStreams({
      staleBefore: new Date('2026-03-16T00:00:00.000Z')
    });

    expect(cleared).toHaveLength(2);
    expect(cleared[0]?.requestId).toBe('req_123');
    expect(cleared[1]?.sessionId).toBe('sess_456');
    expect(db.queries[0]?.sql).toContain('delete from in_token_affinity_active_streams');
    expect(db.queries[0]?.sql).toContain('last_touched_at < $1');
  });
});

describe('tokenAffinityRepository contract', () => {
  it('enforces preferred-assignment uniqueness through the live SQL contract', async () => {
    await withContractRepository(async ({ repo }) => {
      const firstClaim = await repo.claimPreferredAssignment({
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        sessionId: 'sess_123',
        credentialId: '00000000-0000-0000-0000-000000000010'
      });

      expect(firstClaim).toMatchObject({
        outcome: 'claimed',
        assignment: {
          credentialId: '00000000-0000-0000-0000-000000000010',
          sessionId: 'sess_123'
        }
      });

      const competingClaim = await repo.claimPreferredAssignment({
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        sessionId: 'sess_other',
        credentialId: '00000000-0000-0000-0000-000000000010'
      });

      expect(competingClaim).toEqual({ outcome: 'credential_unavailable' });

      const reboundSession = await repo.claimPreferredAssignment({
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        sessionId: 'sess_123',
        credentialId: '00000000-0000-0000-0000-000000000011'
      });

      expect(reboundSession).toMatchObject({
        outcome: 'session_already_bound',
        assignment: {
          credentialId: '00000000-0000-0000-0000-000000000010',
          sessionId: 'sess_123'
        }
      });

      const repeatedClaim = await repo.claimPreferredAssignment({
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        sessionId: 'sess_123',
        credentialId: '00000000-0000-0000-0000-000000000010'
      });

      expect(repeatedClaim).toMatchObject({
        outcome: 'already_owned_by_session',
        assignment: {
          credentialId: '00000000-0000-0000-0000-000000000010',
          sessionId: 'sess_123'
        }
      });
    });
  });

  it('preserves the original started_at when the same request id is upserted again', async () => {
    await withContractRepository(async ({ repo, pool }) => {
      await repo.upsertActiveStream({
        requestId: 'req_123',
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credentialId: '00000000-0000-0000-0000-000000000010',
        sessionId: 'sess_123'
      });

      await pool.query(
        `
          update in_token_affinity_active_streams
          set started_at = $2::timestamptz, last_touched_at = $3::timestamptz
          where request_id = $1
        `,
        ['req_123', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:05.000Z']
      );

      const upserted = await repo.upsertActiveStream({
        requestId: 'req_123',
        orgId: '00000000-0000-0000-0000-000000000001',
        provider: 'openai',
        credentialId: '00000000-0000-0000-0000-000000000011',
        sessionId: 'sess_456'
      });

      expect(upserted.startedAt.toISOString()).toBe('2026-03-15T00:00:00.000Z');
      expect(upserted.credentialId).toBe('00000000-0000-0000-0000-000000000011');
      expect(upserted.sessionId).toBe('sess_456');
      expect(upserted.lastTouchedAt.getTime()).toBeGreaterThan(new Date('2026-03-15T00:00:05.000Z').getTime());
    });
  });
});
