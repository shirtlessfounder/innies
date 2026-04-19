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

  it('strips hidden parts (thinking, tool_use, tool_result) from normalizedPayload content', async () => {
    const archives = [makeArchiveRow({ id: 'archive_thinky', openclaw_session_id: 'sess_thinky' })];
    const messages = [
      makeMessageRow({
        request_attempt_archive_id: 'archive_thinky',
        side: 'response',
        ordinal: 0,
        role: 'assistant',
        normalized_payload: {
          role: 'assistant',
          content: [
            // wrapped-json thinking (anthropic via normalizer)
            { type: 'json', value: { type: 'thinking', thinking: '', signature: 'ErQEClk...' } },
            { type: 'json', value: { type: 'redacted_thinking', data: 'opaque' } },
            // top-level thinking (should also be dropped)
            { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
            // tool activity — dominant size driver, UI hides it
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/huge/file' } },
            { type: 'tool_result', tool_use_id: 'call_1', content: 'x'.repeat(50000) },
            { type: 'json', value: { type: 'tool_use', id: 'call_2', name: 'grep' } },
            { type: 'json', value: { type: 'tool_result', content: 'y'.repeat(50000) } },
            // kept
            { type: 'text', text: 'hello world' }
          ]
        }
      })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) return { rows: archives, rowCount: archives.length };
      if (sql.includes('from in_request_attempt_messages')) return { rows: messages, rowCount: messages.length };
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({ apiKeyIds: ['key_mine'] });

    const parts = feed.sessions[0].turns[0].messages[0].normalizedPayload.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('strips image parts nested inside tool_result content (claude shape)', async () => {
    const archives = [makeArchiveRow({ id: 'archive_img', openclaw_session_id: 'sess_img' })];
    const messages = [
      makeMessageRow({
        request_attempt_archive_id: 'archive_img',
        side: 'request',
        ordinal: 0,
        role: 'user',
        normalized_payload: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_img',
              content: [
                { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo' + 'A'.repeat(10_000) } },
                { type: 'text', text: 'screenshot captured' }
              ]
            },
            { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo' + 'B'.repeat(10_000) } },
            { type: 'text', text: 'what do you see' }
          ]
        }
      })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) return { rows: archives, rowCount: archives.length };
      if (sql.includes('from in_request_attempt_messages')) return { rows: messages, rowCount: messages.length };
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({ apiKeyIds: ['key_mine'] });

    const parts = feed.sessions[0].turns[0].messages[0].normalizedPayload.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'text', text: 'what do you see' });
    expect(JSON.stringify(feed)).not.toContain('iVBORw0KGgo');
  });

  it('drops messages with role=system (title generators, CLI system prompts)', async () => {
    const archives = [makeArchiveRow({ id: 'archive_sys', openclaw_session_id: 'sess_sys' })];
    const messages = [
      makeMessageRow({
        request_attempt_archive_id: 'archive_sys',
        side: 'request',
        ordinal: 0,
        role: 'system',
        normalized_payload: { role: 'system', content: [{ type: 'text', text: 'Generate a concise title...' }] }
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_sys',
        side: 'request',
        ordinal: 1,
        role: 'user',
        normalized_payload: { role: 'user', content: [{ type: 'text', text: 'the actual user question' }] }
      })
    ];
    const db = new MultiQueryClient((sql) => {
      if (sql.includes('from in_request_attempt_archives')) return { rows: archives, rowCount: archives.length };
      if (sql.includes('from in_request_attempt_messages')) return { rows: messages, rowCount: messages.length };
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({ apiKeyIds: ['key_mine'] });

    const turnMessages = feed.sessions[0].turns[0].messages;
    expect(turnMessages).toHaveLength(1);
    expect(turnMessages[0].role).toBe('user');
    expect(JSON.stringify(feed)).not.toContain('Generate a concise title');
  });

  it('dedupes cumulative messages across turns by (side, ordinal)', async () => {
    // Claude/Codex sessions re-send the full history each turn. The panel
    // only renders newly-appended (side, ordinal) pairs, so the server
    // should drop the duplicates before shipping them.
    const archives = [
      makeArchiveRow({
        id: 'archive_t1',
        openclaw_session_id: 'sess_dedup',
        started_at: new Date('2026-04-19T00:00:10Z'),
        completed_at: new Date('2026-04-19T00:00:11Z')
      }),
      makeArchiveRow({
        id: 'archive_t2',
        openclaw_session_id: 'sess_dedup',
        started_at: new Date('2026-04-19T00:00:20Z'),
        completed_at: new Date('2026-04-19T00:00:21Z')
      }),
      makeArchiveRow({
        id: 'archive_t3',
        openclaw_session_id: 'sess_dedup',
        started_at: new Date('2026-04-19T00:00:30Z'),
        completed_at: new Date('2026-04-19T00:00:31Z')
      })
    ];
    const messages = [
      // turn 1: user q1, assistant a1
      makeMessageRow({ request_attempt_archive_id: 'archive_t1', side: 'request', ordinal: 0 }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_t1',
        side: 'response',
        ordinal: 0,
        role: 'assistant'
      }),
      // turn 2: re-sends turn 1 history + new user q2, new assistant a2
      makeMessageRow({ request_attempt_archive_id: 'archive_t2', side: 'request', ordinal: 0 }),
      makeMessageRow({ request_attempt_archive_id: 'archive_t2', side: 'request', ordinal: 1 }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_t2',
        side: 'response',
        ordinal: 0,
        role: 'assistant'
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_t2',
        side: 'response',
        ordinal: 1,
        role: 'assistant'
      }),
      // turn 3: re-sends turns 1+2 history + new user q3
      makeMessageRow({ request_attempt_archive_id: 'archive_t3', side: 'request', ordinal: 0 }),
      makeMessageRow({ request_attempt_archive_id: 'archive_t3', side: 'request', ordinal: 1 }),
      makeMessageRow({ request_attempt_archive_id: 'archive_t3', side: 'request', ordinal: 2 }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_t3',
        side: 'response',
        ordinal: 0,
        role: 'assistant'
      }),
      makeMessageRow({
        request_attempt_archive_id: 'archive_t3',
        side: 'response',
        ordinal: 1,
        role: 'assistant'
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

    const session = feed.sessions[0];
    expect(session.sessionKey).toBe('sess_dedup');
    // turn 1 keeps everything (it's the first in the slice).
    expect(session.turns[0].messages.map((m) => [m.side, m.ordinal])).toEqual([
      ['request', 0],
      ['response', 0]
    ]);
    // turn 2 drops the duplicates (request/response ordinal 0) and keeps only the new ones.
    expect(session.turns[1].messages.map((m) => [m.side, m.ordinal])).toEqual([
      ['request', 1],
      ['response', 1]
    ]);
    // turn 3 drops everything <= max seen so far; only request ordinal 2 is new.
    expect(session.turns[2].messages.map((m) => [m.side, m.ordinal])).toEqual([
      ['request', 2]
    ]);
  });

  it('slices archives to last N per session BEFORE loading messages, so ownership lands in the visible window', async () => {
    // A long-running session with 25 archives — only the last 20 should reach
    // loadMessages, and the session metadata should still reflect the full
    // window (earliest start, latest completion).
    const archives: Record<string, unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      archives.push(
        makeArchiveRow({
          id: `archive_long_${i}`,
          request_id: `req_long_${i}`,
          openclaw_session_id: 'sess_long',
          started_at: new Date(Date.parse('2026-04-19T00:00:00Z') + i * 60_000),
          completed_at: new Date(Date.parse('2026-04-19T00:00:00Z') + i * 60_000 + 5_000)
        })
      );
    }
    // Each archive owns one message when loadMessages is called for it.
    const db = new MultiQueryClient((sql, params) => {
      if (sql.includes('from in_request_attempt_archives')) {
        return { rows: archives, rowCount: archives.length };
      }
      if (sql.includes('from in_request_attempt_messages')) {
        const ids = params[0] as string[];
        const rows = ids.map((id) =>
          makeMessageRow({
            request_attempt_archive_id: id,
            side: 'request',
            ordinal: 0,
            normalized_payload: { role: 'user', content: [{ type: 'text', text: id }] }
          })
        );
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new MyLiveSessionsService({ sql: db });

    const feed = await svc.listFeed({
      apiKeyIds: ['key_mine'],
      now: new Date('2026-04-19T02:00:00Z')
    });

    const messagesQuery = db.queries.find((q) => q.sql.includes('from in_request_attempt_messages'));
    expect(messagesQuery).toBeDefined();
    const loadedIds = messagesQuery!.params[0] as string[];
    // Only the last 20 archives' IDs should have been queried.
    expect(loadedIds).toHaveLength(20);
    expect(loadedIds).toContain('archive_long_24');
    expect(loadedIds).toContain('archive_long_5');
    expect(loadedIds).not.toContain('archive_long_4');
    expect(loadedIds).not.toContain('archive_long_0');

    // Session metadata still covers the full 25-archive window.
    const session = feed.sessions[0];
    expect(session.sessionKey).toBe('sess_long');
    expect(session.startedAt).toBe('2026-04-19T00:00:00.000Z');
    expect(session.lastActivityAt).toBe('2026-04-19T00:24:05.000Z');
    expect(session.turnCount).toBe(20);
    expect(session.turns).toHaveLength(20);
    expect(session.turns[0].archiveId).toBe('archive_long_5');
    expect(session.turns[19].archiveId).toBe('archive_long_24');
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
