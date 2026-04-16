import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TABLES } from '../src/repos/tableNames.js';
import type { SqlClient, SqlQueryResult, SqlValue, TransactionContext } from '../src/repos/sqlClient.js';
import { PublicLiveSessionsService } from '../src/services/publicInnies/publicLiveSessionsService.js';
import { sha256Hex } from '../src/utils/hash.js';

type QueryStep = SqlQueryResult | { error: unknown };

class SequenceSqlClient implements SqlClient {
  readonly queries: Array<{ sql: string; params?: SqlValue[] }> = [];

  constructor(private readonly steps: QueryStep[]) {}

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, params });
    const next = this.steps.shift() ?? { rows: [], rowCount: 0 };
    if ('error' in next) {
      throw next.error;
    }
    return next as SqlQueryResult<T>;
  }

  async transaction<T>(run: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return run(this);
  }
}

function sessionRow(input: {
  sessionKey: string;
  sessionType?: 'cli' | 'openclaw';
  startedAt: string;
  endedAt: string;
  lastActivityAt: string;
  providerSet?: string[];
  modelSet?: string[];
}): Record<string, unknown> {
  return {
    session_key: input.sessionKey,
    session_type: input.sessionType ?? 'openclaw',
    started_at: input.startedAt,
    ended_at: input.endedAt,
    last_activity_at: input.lastActivityAt,
    source_session_id: `${input.sessionKey}:source`,
    source_run_id: `${input.sessionKey}:run`,
    provider_set: input.providerSet ?? ['openai'],
    model_set: input.modelSet ?? ['gpt-5.2']
  };
}

function attemptRow(input: {
  sessionKey: string;
  archiveId: string;
  requestId: string;
  attemptNo: number;
  apiKeyId: string | null;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string | null;
  providerFallbackFrom?: string | null;
  providerSelectionReason?: string | null;
}): Record<string, unknown> {
  return {
    session_key: input.sessionKey,
    request_attempt_archive_id: input.archiveId,
    request_id: input.requestId,
    attempt_no: input.attemptNo,
    api_key_id: input.apiKeyId,
    provider: input.provider,
    model: input.model,
    started_at: input.startedAt,
    completed_at: input.completedAt ?? null,
    route_decision: {
      ...(input.providerFallbackFrom ? { provider_fallback_from: input.providerFallbackFrom } : {}),
      ...(input.providerSelectionReason ? { provider_selection_reason: input.providerSelectionReason } : {})
    }
  };
}

function messageRow(input: {
  archiveId: string;
  side: 'request' | 'response';
  ordinal: number;
  role: string;
  content: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    request_attempt_archive_id: input.archiveId,
    side: input.side,
    ordinal: input.ordinal,
    role: input.role,
    normalized_payload: {
      role: input.role,
      content: input.content
    }
  };
}

function directAttemptRow(input: {
  archiveId: string;
  requestId: string;
  attemptNo: number;
  apiKeyId: string | null;
  provider: string;
  model: string;
  startedAt: string;
  completedAt?: string | null;
  promptCacheKey: string;
  providerFallbackFrom?: string | null;
  providerSelectionReason?: string | null;
}): Record<string, unknown> {
  return {
    request_attempt_archive_id: input.archiveId,
    request_id: input.requestId,
    attempt_no: input.attemptNo,
    api_key_id: input.apiKeyId,
    provider: input.provider,
    model: input.model,
    started_at: input.startedAt,
    completed_at: input.completedAt ?? null,
    route_decision: {
      request_source: 'direct',
      ...(input.providerFallbackFrom ? { provider_fallback_from: input.providerFallbackFrom } : {}),
      ...(input.providerSelectionReason ? { provider_selection_reason: input.providerSelectionReason } : {})
    },
    raw_request_encoding: 'gzip',
    raw_request_payload: gzipSync(Buffer.from(JSON.stringify({
      prompt_cache_key: input.promptCacheKey
    }), 'utf8'))
  };
}

function rawRequestBlobRow(input: {
  archiveId: string;
  promptCacheKey: string;
}): Record<string, unknown> {
  return {
    request_attempt_archive_id: input.archiveId,
    encoding: 'gzip',
    payload: gzipSync(Buffer.from(JSON.stringify({
      prompt_cache_key: input.promptCacheKey
    }), 'utf8'))
  };
}

describe('publicLiveSessionsService', () => {
  const originalExcludedBuyerKeys = process.env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS;
  const defaultExcludedBuyerKey = 'REDACTED_EXCLUDED_BUYER_KEY';

  beforeEach(() => {
    delete process.env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS;
  });

  afterEach(() => {
    if (originalExcludedBuyerKeys == null) {
      delete process.env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS;
      return;
    }
    process.env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS = originalExcludedBuyerKeys;
  });

  it('builds a sanitized public feed from active innies sessions and excludes configured buyer keys', async () => {
    process.env.INNIES_PUBLIC_EXCLUDED_BUYER_KEYS = ' keep-out-a , , keep-out-b ';

    const now = new Date('2026-04-02T18:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: [
          sessionRow({
            sessionKey: 'sess_public_1',
            startedAt: '2026-04-02T17:40:00.000Z',
            endedAt: '2026-04-02T17:59:00.000Z',
            lastActivityAt: '2026-04-02T17:59:00.000Z',
            providerSet: ['anthropic', 'openai'],
            modelSet: ['claude-sonnet-4-5', 'gpt-5.2']
          }),
          sessionRow({
            sessionKey: 'sess_excluded_only',
            startedAt: '2026-04-02T17:52:00.000Z',
            endedAt: '2026-04-02T17:58:00.000Z',
            lastActivityAt: '2026-04-02T17:58:00.000Z'
          }),
          sessionRow({
            sessionKey: 'sess_stale',
            startedAt: '2026-04-02T16:30:00.000Z',
            endedAt: '2026-04-02T16:40:00.000Z',
            lastActivityAt: '2026-04-02T16:40:00.000Z'
          })
        ],
        rowCount: 3
      },
      {
        rows: [
          attemptRow({
            sessionKey: 'sess_public_1',
            archiveId: 'arch_keep_1',
            requestId: 'req_keep_1',
            attemptNo: 1,
            apiKeyId: 'api_keep',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            startedAt: '2026-04-02T17:50:00.000Z',
            completedAt: '2026-04-02T17:51:00.000Z'
          }),
          attemptRow({
            sessionKey: 'sess_public_1',
            archiveId: 'arch_keep_2',
            requestId: 'req_keep_2',
            attemptNo: 2,
            apiKeyId: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.2',
            startedAt: '2026-04-02T17:58:00.000Z',
            completedAt: '2026-04-02T17:59:00.000Z',
            providerFallbackFrom: 'anthropic',
            providerSelectionReason: 'fallback_provider_selected'
          }),
          attemptRow({
            sessionKey: 'sess_excluded_only',
            archiveId: 'arch_excluded_only',
            requestId: 'req_excluded_only',
            attemptNo: 1,
            apiKeyId: 'api_excluded',
            provider: 'openai',
            model: 'gpt-5.2',
            startedAt: '2026-04-02T17:57:00.000Z',
            completedAt: '2026-04-02T17:58:00.000Z'
          }),
          attemptRow({
            sessionKey: 'sess_public_1',
            archiveId: 'arch_old_history',
            requestId: 'req_old_history',
            attemptNo: 3,
            apiKeyId: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.2',
            startedAt: '2026-04-02T16:20:00.000Z',
            completedAt: '2026-04-02T16:21:00.000Z'
          })
        ],
        rowCount: 4
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          messageRow({
            archiveId: 'arch_keep_1',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{
              type: 'text',
              text: 'show Authorization: Bearer sk-proj-request-secret and /Users/example/private.txt'
            }]
          }),
          messageRow({
            archiveId: 'arch_keep_1',
            side: 'request',
            ordinal: 1,
            role: 'system',
            content: [{
              type: 'text',
              text: 'system prompt should not ship'
            }]
          }),
          messageRow({
            archiveId: 'arch_keep_1',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [
              { type: 'json', value: { reasoning: 'private' } },
              { type: 'text', text: 'assistant update for ops@innies.dev' },
              { type: 'text', text: 'data: {"type":"response.output_text.delta","delta":"drop me"}' },
              {
                type: 'tool_call',
                id: 'tool_1',
                name: 'grep',
                arguments: {
                  authorization: 'Bearer sk-proj-tool-secret',
                  file: '/Users/example/.ssh/config'
                }
              },
              {
                type: 'tool_result',
                toolUseId: 'tool_1',
                content: {
                  message: 'result ready',
                  token: 'sk-proj-tool-output'
                }
              }
            ]
          }),
          messageRow({
            archiveId: 'arch_keep_2',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'retry with openai please' }]
          }),
          messageRow({
            archiveId: 'arch_keep_2',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [
              { type: 'text', text: '{"debug":true}' },
              { type: 'text', text: 'done for ops@innies.dev' }
            ]
          })
        ],
        rowCount: 5
      }
    ]);

    const apiKeys = {
      findIdByHash: vi.fn(async (hash: string) => {
        if (hash === sha256Hex('keep-out-a')) {
          return 'api_excluded';
        }
        return null;
      })
    };

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys,
      now: () => now
    });

    const feed = await service.listFeed();

    expect(apiKeys.findIdByHash).toHaveBeenCalledTimes(3);
    expect(apiKeys.findIdByHash).toHaveBeenNthCalledWith(1, sha256Hex(defaultExcludedBuyerKey));
    expect(apiKeys.findIdByHash).toHaveBeenNthCalledWith(2, sha256Hex('keep-out-a'));
    expect(apiKeys.findIdByHash).toHaveBeenNthCalledWith(3, sha256Hex('keep-out-b'));

    expect(db.queries[0]?.params).toEqual(['innies']);
    expect(db.queries[1]?.sql).toContain('from in_admin_sessions');
    expect(db.queries[2]?.sql).toContain('from in_admin_session_attempts');
    expect(db.queries[3]?.sql).toContain(`from ${TABLES.routingEvents} re`);
    expect(db.queries[3]?.sql).toContain(`inner join ${TABLES.requestAttemptArchives} a`);
    expect(db.queries[4]?.sql).toContain('from in_request_attempt_messages');
    expect(db.queries[4]?.params?.[0]).toEqual(['arch_keep_1', 'arch_keep_2']);

    expect(feed).toEqual({
      orgSlug: 'innies',
      generatedAt: '2026-04-02T18:00:00.000Z',
      pollIntervalSeconds: 30,
      idleTimeoutSeconds: 900,
      historyWindowSeconds: 3600,
      sessions: [{
        sessionKey: 'sess_public_1',
        sessionType: 'openclaw',
        displayTitle: 'openclaw sess_public_1',
        startedAt: '2026-04-02T17:40:00.000Z',
        endedAt: '2026-04-02T17:59:00.000Z',
        lastActivityAt: '2026-04-02T17:59:00.000Z',
        currentProvider: 'openai',
        currentModel: 'gpt-5.2',
        providerSet: ['anthropic', 'openai'],
        modelSet: ['claude-sonnet-4-5', 'gpt-5.2'],
        entries: [
          {
            entryId: 'arch_keep_1:0:user',
            kind: 'user',
            at: '2026-04-02T17:51:00.000Z',
            text: 'show Authorization: [REDACTED_CREDENTIAL] and [REDACTED_PATH]'
          },
          {
            entryId: 'arch_keep_1:1:assistant_final',
            kind: 'assistant_final',
            at: '2026-04-02T17:51:00.000Z',
            text: 'assistant update for [REDACTED_EMAIL]'
          },
          {
            entryId: 'arch_keep_2:2:user',
            kind: 'user',
            at: '2026-04-02T17:59:00.000Z',
            text: 'retry with openai please'
          },
          {
            entryId: 'arch_keep_2:3:assistant_final',
            kind: 'assistant_final',
            at: '2026-04-02T17:59:00.000Z',
            text: 'done for [REDACTED_EMAIL]'
          }
        ]
      }]
    });
  });

  it('excludes the built-in buyer key even when no env override is set', async () => {
    const now = new Date('2026-04-02T18:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: [
          sessionRow({
            sessionKey: 'sess_public_1',
            startedAt: '2026-04-02T17:40:00.000Z',
            endedAt: '2026-04-02T17:59:00.000Z',
            lastActivityAt: '2026-04-02T17:59:00.000Z'
          }),
          sessionRow({
            sessionKey: 'sess_hidden_default',
            startedAt: '2026-04-02T17:52:00.000Z',
            endedAt: '2026-04-02T17:58:00.000Z',
            lastActivityAt: '2026-04-02T17:58:00.000Z'
          })
        ],
        rowCount: 2
      },
      {
        rows: [
          attemptRow({
            sessionKey: 'sess_public_1',
            archiveId: 'arch_keep_1',
            requestId: 'req_keep_1',
            attemptNo: 1,
            apiKeyId: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.2',
            startedAt: '2026-04-02T17:50:00.000Z',
            completedAt: '2026-04-02T17:51:00.000Z'
          }),
          attemptRow({
            sessionKey: 'sess_hidden_default',
            archiveId: 'arch_hidden_default',
            requestId: 'req_hidden_default',
            attemptNo: 1,
            apiKeyId: 'api_hidden_default',
            provider: 'openai',
            model: 'gpt-5.2',
            startedAt: '2026-04-02T17:57:00.000Z',
            completedAt: '2026-04-02T17:58:00.000Z'
          })
        ],
        rowCount: 2
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          messageRow({
            archiveId: 'arch_keep_1',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'keep this visible' }]
          }),
          messageRow({
            archiveId: 'arch_hidden_default',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'this should never be public' }]
          })
        ],
        rowCount: 2
      }
    ]);

    const apiKeys = {
      findIdByHash: vi.fn(async (keyHash: string) => {
        if (keyHash === sha256Hex(defaultExcludedBuyerKey)) {
          return 'api_hidden_default';
        }
        return null;
      })
    };

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys,
      now: () => now
    });

    const feed = await service.listFeed();

    expect(apiKeys.findIdByHash).toHaveBeenCalledWith(sha256Hex(defaultExcludedBuyerKey));
    expect(feed.sessions).toHaveLength(1);
    expect(feed.sessions[0]?.sessionKey).toBe('sess_public_1');
  });

  it('caps the feed at 24 sessions and 120 shaped entries per session', async () => {
    const now = new Date('2026-04-02T18:00:00.000Z');
    const sessions = Array.from({ length: 26 }, (_, index) => sessionRow({
      sessionKey: index === 0 ? 'sess_dense' : `sess_${String(index).padStart(2, '0')}`,
      sessionType: index % 2 === 0 ? 'openclaw' : 'cli',
      startedAt: '2026-04-02T17:50:00.000Z',
      endedAt: '2026-04-02T17:59:00.000Z',
      lastActivityAt: '2026-04-02T17:59:00.000Z'
    }));

    const attempts = Array.from({ length: 26 }, (_, index) => attemptRow({
      sessionKey: index === 0 ? 'sess_dense' : `sess_${String(index).padStart(2, '0')}`,
      archiveId: index === 0 ? 'arch_dense' : `arch_${String(index).padStart(2, '0')}`,
      requestId: `req_${index}`,
      attemptNo: 1,
      apiKeyId: 'api_keep',
      provider: 'openai',
      model: 'gpt-5.2',
      startedAt: '2026-04-02T17:58:00.000Z',
      completedAt: '2026-04-02T17:59:00.000Z'
    }));

    const denseMessages = Array.from({ length: 125 }, (_, index) => messageRow({
      archiveId: 'arch_dense',
      side: 'request',
      ordinal: index,
      role: 'user',
      content: [{ type: 'text', text: `entry-${index + 1}` }]
    }));

    const sparseMessages = Array.from({ length: 25 }, (_, index) => messageRow({
      archiveId: `arch_${String(index + 1).padStart(2, '0')}`,
      side: 'request',
      ordinal: 0,
      role: 'user',
      content: [{ type: 'text', text: `sparse-${index + 1}` }]
    }));

    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: sessions,
        rowCount: sessions.length
      },
      {
        rows: attempts,
        rowCount: attempts.length
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: denseMessages.concat(sparseMessages),
        rowCount: denseMessages.length + sparseMessages.length
      }
    ]);

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys: { findIdByHash: vi.fn(async () => null) },
      now: () => now
    });

    const feed = await service.listFeed();

    expect(feed.sessions).toHaveLength(24);
    expect(feed.sessions.some((session) => session.sessionKey === 'sess_dense')).toBe(true);
    expect(feed.sessions.some((session) => session.sessionKey === 'sess_01')).toBe(false);
    expect(feed.sessions.some((session) => session.sessionKey === 'sess_02')).toBe(false);

    const denseSession = feed.sessions.find((session) => session.sessionKey === 'sess_dense');
    expect(denseSession?.entries).toHaveLength(120);
    expect(denseSession?.entries[0]).toEqual({
      entryId: 'arch_dense:0:user',
      kind: 'user',
      at: '2026-04-02T17:59:00.000Z',
      text: 'entry-6'
    });
    expect(denseSession?.entries.at(-1)).toEqual({
      entryId: 'arch_dense:119:user',
      kind: 'user',
      at: '2026-04-02T17:59:00.000Z',
      text: 'entry-125'
    });
  });

  it('falls back to the legacy internal org slug and builds direct prompt-cache sessions without admin session rows', async () => {
    const now = new Date('2026-04-02T18:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [{ id: 'org_team_seller' }],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          directAttemptRow({
            archiveId: 'arch_direct_1',
            requestId: 'req_direct_1',
            attemptNo: 1,
            apiKeyId: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.4',
            startedAt: '2026-04-02T17:54:00.000Z',
            completedAt: '2026-04-02T17:55:00.000Z',
            promptCacheKey: 'cache_live_1'
          }),
          directAttemptRow({
            archiveId: 'arch_direct_2',
            requestId: 'req_direct_2',
            attemptNo: 1,
            apiKeyId: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.4',
            startedAt: '2026-04-02T17:58:00.000Z',
            completedAt: '2026-04-02T17:59:00.000Z',
            promptCacheKey: 'cache_live_1'
          })
        ],
        rowCount: 2
      },
      {
        rows: [
          rawRequestBlobRow({
            archiveId: 'arch_direct_2',
            promptCacheKey: 'cache_live_1'
          }),
          rawRequestBlobRow({
            archiveId: 'arch_direct_1',
            promptCacheKey: 'cache_live_1'
          })
        ],
        rowCount: 2
      },
      {
        rows: [
          messageRow({
            archiveId: 'arch_direct_1',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'ship the patch' }]
          }),
          messageRow({
            archiveId: 'arch_direct_1',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [{ type: 'text', text: 'working through the API fix' }]
          }),
          messageRow({
            archiveId: 'arch_direct_2',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'verify the feed again' }]
          }),
          messageRow({
            archiveId: 'arch_direct_2',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [{ type: 'text', text: 'feed looks live now' }]
          })
        ],
        rowCount: 4
      }
    ]);

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys: { findIdByHash: vi.fn(async () => null) },
      now: () => now
    });

    const feed = await service.listFeed();

    expect(db.queries[0]?.params).toEqual(['innies']);
    expect(db.queries[1]?.params).toEqual(['team-seller']);
    expect(db.queries[2]?.sql).toContain('from in_admin_sessions');
    expect(db.queries[3]?.sql).toContain(`from ${TABLES.routingEvents} re`);
    expect(db.queries[3]?.sql).toContain(`inner join ${TABLES.requestAttemptArchives} a`);
    expect(db.queries[4]?.sql).toContain(`from ${TABLES.requestAttemptRawBlobs}`);
    expect(db.queries[4]?.params?.[0]).toEqual(['arch_direct_1', 'arch_direct_2']);
    expect(db.queries[5]?.params?.[0]).toEqual(['arch_direct_1', 'arch_direct_2']);

    expect(feed.sessions).toEqual([{
      sessionKey: 'cli:prompt-cache:cache_live_1',
      sessionType: 'cli',
      displayTitle: 'cli cache_live_1',
      startedAt: '2026-04-02T17:54:00.000Z',
      endedAt: '2026-04-02T17:59:00.000Z',
      lastActivityAt: '2026-04-02T17:59:00.000Z',
      currentProvider: 'openai',
      currentModel: 'gpt-5.4',
      providerSet: ['openai'],
      modelSet: ['gpt-5.4'],
      entries: [
        {
          entryId: 'arch_direct_1:0:user',
          kind: 'user',
          at: '2026-04-02T17:55:00.000Z',
          text: 'ship the patch'
        },
        {
          entryId: 'arch_direct_1:1:assistant_final',
          kind: 'assistant_final',
          at: '2026-04-02T17:55:00.000Z',
          text: 'working through the API fix'
        },
        {
          entryId: 'arch_direct_2:2:user',
          kind: 'user',
          at: '2026-04-02T17:59:00.000Z',
          text: 'verify the feed again'
        },
        {
          entryId: 'arch_direct_2:3:assistant_final',
          kind: 'assistant_final',
          at: '2026-04-02T17:59:00.000Z',
          text: 'feed looks live now'
        }
      ]
    }]);
  });

  it('falls back to request id for pinned codex direct sessions when prompt_cache_key is missing', async () => {
    const now = new Date('2026-04-02T18:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          {
            request_attempt_archive_id: 'arch_direct_native_1',
            request_id: 'req_native_codex_session',
            attempt_no: 1,
            api_key_id: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.4',
            started_at: '2026-04-02T17:54:00.000Z',
            completed_at: '2026-04-02T17:55:00.000Z',
            route_decision: {
              request_source: 'direct',
              provider_selection_reason: 'cli_provider_pinned'
            }
          },
          {
            request_attempt_archive_id: 'arch_direct_native_2',
            request_id: 'req_native_codex_session',
            attempt_no: 1,
            api_key_id: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.4',
            started_at: '2026-04-02T17:58:00.000Z',
            completed_at: '2026-04-02T17:59:00.000Z',
            route_decision: {
              request_source: 'direct',
              provider_selection_reason: 'cli_provider_pinned'
            }
          }
        ],
        rowCount: 2
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          messageRow({
            archiveId: 'arch_direct_native_1',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'show my active codex session' }]
          }),
          messageRow({
            archiveId: 'arch_direct_native_1',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [{ type: 'text', text: 'surfacing the pinned session now' }]
          }),
          messageRow({
            archiveId: 'arch_direct_native_2',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'keep this pinned session visible' }]
          }),
          messageRow({
            archiveId: 'arch_direct_native_2',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [{ type: 'text', text: 'latest codex activity is still live' }]
          })
        ],
        rowCount: 4
      }
    ]);

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys: { findIdByHash: vi.fn(async () => null) },
      now: () => now
    });

    const feed = await service.listFeed();

    expect(db.queries[2]?.params).toEqual([
      'org_innies',
      '2026-04-02T17:00:00.000Z',
      2400,
      '2026-04-02T17:00:00.000Z',
      400
    ]);
    expect(db.queries[3]?.params?.[0]).toEqual(['arch_direct_native_1', 'arch_direct_native_2']);

    expect(feed.sessions).toEqual([{
      sessionKey: 'cli:request:req_native_codex_session',
      sessionType: 'cli',
      displayTitle: 'cli req_nati...sion',
      startedAt: '2026-04-02T17:54:00.000Z',
      endedAt: '2026-04-02T17:59:00.000Z',
      lastActivityAt: '2026-04-02T17:59:00.000Z',
      currentProvider: 'openai',
      currentModel: 'gpt-5.4',
      providerSet: ['openai'],
      modelSet: ['gpt-5.4'],
      entries: [
        {
          entryId: 'arch_direct_native_1:0:user',
          kind: 'user',
          at: '2026-04-02T17:55:00.000Z',
          text: 'show my active codex session'
        },
        {
          entryId: 'arch_direct_native_1:1:assistant_final',
          kind: 'assistant_final',
          at: '2026-04-02T17:55:00.000Z',
          text: 'surfacing the pinned session now'
        },
        {
          entryId: 'arch_direct_native_2:2:user',
          kind: 'user',
          at: '2026-04-02T17:59:00.000Z',
          text: 'keep this pinned session visible'
        },
        {
          entryId: 'arch_direct_native_2:3:assistant_final',
          kind: 'assistant_final',
          at: '2026-04-02T17:59:00.000Z',
          text: 'latest codex activity is still live'
        }
      ]
    }]);
  });

  it('drives direct live-session discovery from recent routing events instead of scanning all archives in-window', async () => {
    const now = new Date('2026-04-02T18:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [],
        rowCount: 0
      }
    ]);

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys: { findIdByHash: vi.fn(async () => null) },
      now: () => now
    });

    const feed = await service.listFeed();

    expect(feed.sessions).toEqual([]);
    expect(db.queries[2]?.sql).toContain(`from ${TABLES.routingEvents} re`);
    expect(db.queries[2]?.sql).toContain("nullif(re.route_decision->>'request_source', '') = 'direct'");
    expect(db.queries[2]?.sql).toContain('re.created_at >= $2::timestamptz');
    expect(db.queries[2]?.sql).not.toContain('left join');
    expect(db.queries[2]?.params).toEqual([
      'org_innies',
      '2026-04-02T17:00:00.000Z',
      2400,
      '2026-04-02T17:00:00.000Z',
      400
    ]);
  });

  it('surfaces archived direct fallback requests even when prompt_cache_key is missing', async () => {
    const now = new Date('2026-04-16T02:00:00.000Z');
    const db = new SequenceSqlClient([
      {
        rows: [{ id: 'org_innies' }],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          {
            request_attempt_archive_id: 'arch_direct_fallback_1',
            request_id: 'req_direct_fallback_1',
            attempt_no: 1,
            api_key_id: 'api_keep',
            provider: 'openai',
            model: 'gpt-5.4-mini',
            started_at: '2026-04-16T01:59:35.724Z',
            completed_at: '2026-04-16T01:59:54.864Z',
            route_decision: {
              request_source: 'direct',
              provider_selection_reason: 'fallback_provider_selected',
              provider_fallback_from: 'anthropic'
            }
          }
        ],
        rowCount: 1
      },
      {
        rows: [],
        rowCount: 0
      },
      {
        rows: [
          messageRow({
            archiveId: 'arch_direct_fallback_1',
            side: 'request',
            ordinal: 0,
            role: 'user',
            content: [{ type: 'text', text: 'show the live session anyway' }]
          }),
          messageRow({
            archiveId: 'arch_direct_fallback_1',
            side: 'response',
            ordinal: 0,
            role: 'assistant',
            content: [{ type: 'text', text: 'visible despite missing prompt cache key' }]
          })
        ],
        rowCount: 2
      }
    ]);

    const service = new PublicLiveSessionsService({
      sql: db,
      apiKeys: { findIdByHash: vi.fn(async () => null) },
      now: () => now
    });

    const feed = await service.listFeed();

    expect(feed.sessions).toEqual([{
      sessionKey: 'cli:request:req_direct_fallback_1',
      sessionType: 'cli',
      displayTitle: 'cli req_dire...ck_1',
      startedAt: '2026-04-16T01:59:35.724Z',
      endedAt: '2026-04-16T01:59:54.864Z',
      lastActivityAt: '2026-04-16T01:59:54.864Z',
      currentProvider: 'openai',
      currentModel: 'gpt-5.4-mini',
      providerSet: ['openai'],
      modelSet: ['gpt-5.4-mini'],
      entries: [
        {
          entryId: 'arch_direct_fallback_1:0:user',
          kind: 'user',
          at: '2026-04-16T01:59:54.864Z',
          text: 'show the live session anyway'
        },
        {
          entryId: 'arch_direct_fallback_1:1:assistant_final',
          kind: 'assistant_final',
          at: '2026-04-16T01:59:54.864Z',
          text: 'visible despite missing prompt cache key'
        }
      ]
    }]);
  });
});
