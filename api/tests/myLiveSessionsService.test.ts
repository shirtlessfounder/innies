import { describe, expect, it } from 'vitest';
import { MyLiveSessionsService } from '../src/services/adminLive/myLiveSessionsService.js';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';

type QueryHandler = (sql: string, params: SqlValue[]) => SqlQueryResult;

class MultiQueryClient implements SqlClient {
  readonly queries: Array<{ sql: string; params: SqlValue[] }> = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    return this.handler(sql, params) as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

function makeArchiveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    id: 'archive_base',
    request_id: 'req_base',
    attempt_no: 1,
    api_key_id: 'key_mine',
    openclaw_session_id: 'sess_one',
    provider: 'openai',
    model: 'gpt-5.4',
    streaming: true,
    status: 'success',
    upstream_status: 200,
    started_at: new Date('2026-04-19T00:00:00Z'),
    completed_at: new Date('2026-04-19T00:00:05Z')
  };
  return { ...base, ...overrides };
}

function makeMessageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    request_attempt_archive_id: 'archive_base',
    side: 'request',
    ordinal: 0,
    role: 'user',
    content_type: 'text',
    normalized_payload: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  };
  return { ...base, ...overrides };
}

describe('MyLiveSessionsService.listFeed', () => {
  it('returns empty feed when apiKeyIds is empty', async () => {
    const db = new MultiQueryClient(() => ({ rows: [], rowCount: 0 }));
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: [],
      now: new Date('2026-04-19T01:00:00Z')
    });

    expect(feed.sessions).toEqual([]);
    expect(feed.apiKeyIds).toEqual([]);
    expect(feed.windowHours).toBe(24);
    expect(db.queries).toHaveLength(0);
  });

  it('filters archives by api_key_ids and window', async () => {
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    await svc.listFeed({
      apiKeyIds: ['key-uuid-1', 'key-uuid-2'],
      now: new Date('2026-04-19T01:00:00Z'),
      windowHours: 6
    });

    expect(db.queries[0].sql).toContain('from in_request_attempt_archives');
    expect(db.queries[0].sql).toContain('api_key_id = any($1::uuid[])');
    expect(db.queries[0].sql).toContain('started_at >= $2::timestamptz');
    const cutoff = db.queries[0].params[1] as Date;
    expect(cutoff.toISOString()).toBe('2026-04-18T19:00:00.000Z');
    expect(db.queries[0].params[0]).toEqual(['key-uuid-1', 'key-uuid-2']);
  });

  it('clamps windowHours to 7 days max', async () => {
    const db = new MultiQueryClient(() => ({ rows: [], rowCount: 0 }));
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: ['key'],
      now: new Date('2026-04-19T00:00:00Z'),
      windowHours: 999
    });

    expect(feed.windowHours).toBe(168);
  });

  it('clamps negative / zero windowHours to default', async () => {
    const db = new MultiQueryClient(() => ({ rows: [], rowCount: 0 }));
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: ['key'],
      now: new Date('2026-04-19T00:00:00Z'),
      windowHours: -5
    });

    expect(feed.windowHours).toBe(24);
  });

  it('groups archives by openclaw_session_id and orders turns by started_at', async () => {
    const archives = [
      makeArchiveRow({
        id: 'archive_a1',
        request_id: 'req_a1',
        attempt_no: 1,
        openclaw_session_id: 'sess_A',
        started_at: new Date('2026-04-19T00:00:10Z'),
        completed_at: new Date('2026-04-19T00:00:11Z')
      }),
      makeArchiveRow({
        id: 'archive_a2',
        request_id: 'req_a2',
        attempt_no: 1,
        openclaw_session_id: 'sess_A',
        started_at: new Date('2026-04-19T00:00:20Z'),
        completed_at: new Date('2026-04-19T00:00:21Z')
      }),
      makeArchiveRow({
        id: 'archive_b1',
        request_id: 'req_b1',
        attempt_no: 1,
        openclaw_session_id: 'sess_B',
        started_at: new Date('2026-04-19T00:00:30Z'),
        completed_at: new Date('2026-04-19T00:00:31Z')
      })
    ];
    const messages = [
      makeMessageRow({
        request_attempt_archive_id: 'archive_a1',
        side: 'request',
        ordinal: 0,
        normalized_payload: { role: 'user', content: [{ type: 'text', text: 'turn1 req' }] }
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_a1',
        side: 'response',
        ordinal: 0,
        role: 'assistant',
        normalized_payload: { role: 'assistant', content: [{ type: 'text', text: 'turn1 resp' }] }
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_a2',
        side: 'request',
        ordinal: 0,
        normalized_payload: { role: 'user', content: [{ type: 'text', text: 'turn2 req' }] }
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_b1',
        side: 'request',
        ordinal: 0,
        normalized_payload: { role: 'user', content: [{ type: 'text', text: 'solo req' }] }
      })
    ];

    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: archives, rowCount: archives.length };
      }
      if (sql.includes('from in_request_attempt_messages')) {
        return { rows: messages, rowCount: messages.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: ['key_mine'],
      now: new Date('2026-04-19T01:00:00Z')
    });

    expect(feed.sessions).toHaveLength(2);

    const sessionB = feed.sessions[0]; // sorted by lastActivityAt desc
    expect(sessionB.sessionKey).toBe('sess_B');
    expect(sessionB.turnCount).toBe(1);
    expect(sessionB.turns[0].archiveId).toBe('archive_b1');

    const sessionA = feed.sessions[1];
    expect(sessionA.sessionKey).toBe('sess_A');
    expect(sessionA.turnCount).toBe(2);
    // turns ordered by startedAt ascending within a session
    expect(sessionA.turns[0].archiveId).toBe('archive_a1');
    expect(sessionA.turns[1].archiveId).toBe('archive_a2');
    expect(sessionA.turns[0].messages).toHaveLength(2);
    expect(sessionA.turns[0].messages[0].side).toBe('request');
    expect(sessionA.turns[0].messages[1].side).toBe('response');
  });

  it('synthesizes a per-archive fallback session when openclaw_session_id is null', async () => {
    const archives = [
      makeArchiveRow({
        id: 'archive_null1',
        openclaw_session_id: null,
        started_at: new Date('2026-04-19T00:10:00Z'),
        completed_at: new Date('2026-04-19T00:10:05Z')
      }),
      makeArchiveRow({
        id: 'archive_null2',
        openclaw_session_id: null,
        started_at: new Date('2026-04-19T00:11:00Z'),
        completed_at: new Date('2026-04-19T00:11:05Z')
      })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: archives, rowCount: archives.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: ['key_mine'],
      now: new Date('2026-04-19T01:00:00Z')
    });

    expect(feed.sessions).toHaveLength(2);
    expect(feed.sessions[0].sessionKey).toBe('archive:archive_null2');
    expect(feed.sessions[1].sessionKey).toBe('archive:archive_null1');
  });

  it('computes provider/model sets per session', async () => {
    const archives = [
      makeArchiveRow({ id: 'a1', openclaw_session_id: 'sess_mix', provider: 'openai', model: 'gpt-5.4' }),
      makeArchiveRow({ id: 'a2', openclaw_session_id: 'sess_mix', provider: 'anthropic', model: 'claude-opus-4-6' }),
      makeArchiveRow({ id: 'a3', openclaw_session_id: 'sess_mix', provider: 'openai', model: 'gpt-5.4-mini' })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: archives, rowCount: archives.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({ apiKeyIds: ['key_mine'] });

    expect(feed.sessions[0].providerSet.sort()).toEqual(['anthropic', 'openai']);
    expect(feed.sessions[0].modelSet.sort()).toEqual(['claude-opus-4-6', 'gpt-5.4', 'gpt-5.4-mini']);
  });

  it('sanitizes secrets/paths/emails from normalizedPayload before returning', async () => {
    const archives = [
      makeArchiveRow({
        id: 'archive_secretful',
        openclaw_session_id: 'sess_scrub'
      })
    ];
    const messages = [
      makeMessageRow({
        request_attempt_archive_id: 'archive_secretful',
        side: 'request',
        ordinal: 0,
        normalized_payload: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'my key is sk-proj-abc123XYZ_tokenhere',
                'also bearer eyJhbGciOiJIUzI1NiJ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
                'file at /Users/dylan/.ssh/id_ed25519',
                'email me at dylan@innies.work'
              ].join('\n')
            }
          ]
        }
      })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: archives, rowCount: archives.length };
      }
      if (sql.includes('from in_request_attempt_messages')) {
        return { rows: messages, rowCount: messages.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({ apiKeyIds: ['key_mine'] });

    const text = (feed.sessions[0].turns[0].messages[0].normalizedPayload.content as Array<Record<string, unknown>>)[0]
      .text as string;
    // Anything the public sanitizer redacts must also be scrubbed here.
    expect(text).not.toContain('sk-proj-abc123XYZ_tokenhere');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ');
    expect(text).not.toContain('/Users/dylan/.ssh/id_ed25519');
    expect(text).not.toContain('dylan@innies.work');
    expect(text).toContain('[REDACTED_TOKEN]');
    expect(text).toContain('[REDACTED_PATH]');
    expect(text).toContain('[REDACTED_EMAIL]');
  });

  it('does not load messages when no archives match', async () => {
    const db = new MultiQueryClient(() => ({ rows: [], rowCount: 0 }));
    const svc = new MyLiveSessionsService({ sql: db });

    await svc.listFeed({ apiKeyIds: ['key_none'] });

    // only the archive query should have run; messages query skipped
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain('from in_request_attempt_archives');
  });
});
