import { describe, expect, it } from 'vitest';
import type { AdminAnalysisRequestRow } from '../src/repos/adminAnalysisRequestRepository.js';
import type { AdminAnalysisSessionRow } from '../src/repos/adminAnalysisSessionRepository.js';
import type { AdminSessionAttemptRow } from '../src/repos/adminSessionAttemptRepository.js';
import type { AdminSessionRow } from '../src/repos/adminSessionRepository.js';
import type { NormalizedArchiveMessage } from '../src/services/archive/archiveTypes.js';
import {
  AdminAnalysisProjectorService,
  RetryableProjectionDependencyError
} from '../src/services/adminAnalysis/adminAnalysisProjectorService.js';
import { SequenceSqlClient } from './testHelpers.js';

type Candidate = Awaited<ReturnType<ReturnType<typeof createHarness>['candidateLoader']['loadCandidateByArchiveId']>>;

function message(role: NormalizedArchiveMessage['role'], content: NormalizedArchiveMessage['content']): NormalizedArchiveMessage {
  return { role, content };
}

function createHarness() {
  const requestRows: AdminAnalysisRequestRow[] = [];
  const sessionRows: AdminAnalysisSessionRow[] = [];
  const sessionLinks: AdminSessionAttemptRow[] = [];
  const adminSessions: AdminSessionRow[] = [];
  const candidates = new Map<string, NonNullable<Candidate>>();

  const candidateLoader = {
    async loadCandidateByArchiveId(requestAttemptArchiveId: string) {
      return candidates.get(requestAttemptArchiveId) ?? null;
    }
  };

  const service = new AdminAnalysisProjectorService({
    candidateLoader,
    requestRepo: {
      async upsertRequest(input) {
        const row: AdminAnalysisRequestRow = {
          request_attempt_archive_id: input.requestAttemptArchiveId,
          request_id: input.requestId,
          attempt_no: input.attemptNo,
          session_key: input.sessionKey,
          org_id: input.orgId,
          api_key_id: input.apiKeyId,
          session_type: input.sessionType,
          grouping_basis: input.groupingBasis,
          source: input.source,
          provider: input.provider,
          model: input.model,
          status: input.status,
          started_at: input.startedAt.toISOString(),
          completed_at: input.completedAt ? input.completedAt.toISOString() : null,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          user_message_preview: input.userMessagePreview,
          assistant_text_preview: input.assistantTextPreview,
          task_category: input.taskCategory,
          task_tags: [...input.taskTags],
          is_retry: input.isRetry,
          is_failure: input.isFailure,
          is_partial: input.isPartial,
          is_high_token: input.isHighToken,
          is_cross_provider_rescue: input.isCrossProviderRescue,
          has_tool_use: input.hasToolUse,
          interestingness_score: input.interestingnessScore,
          created_at: new Date('2026-03-31T00:00:00Z').toISOString(),
          updated_at: new Date('2026-03-31T00:00:00Z').toISOString()
        };
        const index = requestRows.findIndex((candidate) => candidate.request_attempt_archive_id === row.request_attempt_archive_id);
        if (index >= 0) {
          requestRows[index] = row;
        } else {
          requestRows.push(row);
        }
        return row;
      },
      async findByArchiveId(requestAttemptArchiveId) {
        return requestRows.find((candidate) => candidate.request_attempt_archive_id === requestAttemptArchiveId) ?? null;
      },
      async listBySessionKey(sessionKey) {
        return requestRows
          .filter((candidate) => candidate.session_key === sessionKey)
          .sort((left, right) =>
            new Date(left.started_at).getTime() - new Date(right.started_at).getTime()
            || left.request_id.localeCompare(right.request_id)
            || left.attempt_no - right.attempt_no
          );
      }
    },
    sessionAnalysisRepo: {
      async upsertSession(input) {
        const row: AdminAnalysisSessionRow = {
          session_key: input.sessionKey,
          org_id: input.orgId,
          session_type: input.sessionType,
          grouping_basis: input.groupingBasis,
          started_at: input.startedAt.toISOString(),
          ended_at: input.endedAt.toISOString(),
          last_activity_at: input.lastActivityAt.toISOString(),
          request_count: input.requestCount,
          attempt_count: input.attemptCount,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          primary_task_category: input.primaryTaskCategory,
          task_category_breakdown: structuredClone(input.taskCategoryBreakdown),
          task_tag_set: [...input.taskTagSet],
          is_long_session: input.isLongSession,
          is_high_token_session: input.isHighTokenSession,
          is_retry_heavy_session: input.isRetryHeavySession,
          is_cross_provider_session: input.isCrossProviderSession,
          is_multi_model_session: input.isMultiModelSession,
          interestingness_score: input.interestingnessScore,
          created_at: new Date('2026-03-31T00:00:00Z').toISOString(),
          updated_at: new Date('2026-03-31T00:00:00Z').toISOString()
        };
        const index = sessionRows.findIndex((candidate) => candidate.session_key === row.session_key);
        if (index >= 0) {
          sessionRows[index] = row;
        } else {
          sessionRows.push(row);
        }
        return row;
      },
      async findBySessionKey(sessionKey) {
        return sessionRows.find((candidate) => candidate.session_key === sessionKey) ?? null;
      }
    },
    sessionAttemptRepo: {
      async findByArchiveId(requestAttemptArchiveId) {
        return sessionLinks.find((candidate) => candidate.request_attempt_archive_id === requestAttemptArchiveId) ?? null;
      }
    },
    adminSessionRepo: {
      async findBySessionKey(sessionKey) {
        return adminSessions.find((candidate) => candidate.session_key === sessionKey) ?? null;
      }
    }
  });

  return {
    service,
    requestRows,
    sessionRows,
    sessionLinks,
    adminSessions,
    candidates,
    candidateLoader
  };
}

function candidate(input?: Partial<NonNullable<Candidate>>): NonNullable<Candidate> {
  return {
    requestAttemptArchiveId: 'archive_1',
    requestId: 'req_1',
    attemptNo: 1,
    orgId: 'org_1',
    apiKeyId: 'api_1',
    source: 'openclaw',
    provider: 'openai',
    model: 'gpt-5.4',
    status: 'success',
    startedAt: new Date('2026-03-31T22:00:00Z'),
    completedAt: new Date('2026-03-31T22:05:00Z'),
    inputTokens: 300,
    outputTokens: 500,
    providerFallbackFrom: null,
    requestMessages: [
      message('user', [{ type: 'text', text: 'build the new analysis endpoint' }])
    ],
    responseMessages: [
      message('assistant', [{ type: 'text', text: 'working on it' }])
    ],
    rawResponse: null,
    ...input
  };
}

function adminSession(input?: Partial<AdminSessionRow>): AdminSessionRow {
  return {
    session_key: 'openclaw:session:sess_1',
    session_type: 'openclaw',
    grouping_basis: 'explicit_session_id',
    org_id: 'org_1',
    api_key_id: 'api_1',
    source_session_id: 'sess_1',
    source_run_id: 'run_1',
    started_at: new Date('2026-03-31T22:00:00Z').toISOString(),
    ended_at: new Date('2026-03-31T22:45:00Z').toISOString(),
    last_activity_at: new Date('2026-03-31T22:45:00Z').toISOString(),
    request_count: 2,
    attempt_count: 3,
    input_tokens: 0,
    output_tokens: 0,
    provider_set: ['anthropic', 'openai'],
    model_set: ['claude-opus-4-1', 'gpt-5.4'],
    status_summary: { success: 2 },
    preview_sample: null,
    created_at: new Date('2026-03-31T00:00:00Z').toISOString(),
    updated_at: new Date('2026-03-31T00:00:00Z').toISOString(),
    ...input
  };
}

function sessionLink(input?: Partial<AdminSessionAttemptRow>): AdminSessionAttemptRow {
  return {
    session_key: 'openclaw:session:sess_1',
    request_attempt_archive_id: 'archive_1',
    request_id: 'req_1',
    attempt_no: 1,
    event_time: new Date('2026-03-31T22:05:00Z').toISOString(),
    sequence_no: 0,
    provider: 'openai',
    model: 'gpt-5.4',
    streaming: false,
    status: 'success',
    created_at: new Date('2026-03-31T00:00:00Z').toISOString(),
    ...input
  };
}

describe('AdminAnalysisProjectorService', () => {
  it('ignores direct-source attempts instead of retrying a missing session dependency', async () => {
    const harness = createHarness();
    harness.candidates.set('archive_direct', candidate({
      requestAttemptArchiveId: 'archive_direct',
      requestId: 'req_direct',
      source: 'direct'
    }));

    const result = await harness.service.projectQueuedAttempt({
      request_attempt_archive_id: 'archive_direct'
    });

    expect(result).toEqual({
      outcome: 'ignored',
      reason: 'unsupported_request_source',
      requestAttemptArchiveId: 'archive_direct'
    });
    expect(harness.requestRows).toEqual([]);
    expect(harness.sessionRows).toEqual([]);
  });

  it('treats missing session identity as a retryable dependency', async () => {
    const harness = createHarness();
    harness.candidates.set('archive_1', candidate());

    await expect(harness.service.projectQueuedAttempt({
      request_attempt_archive_id: 'archive_1'
    })).rejects.toBeInstanceOf(RetryableProjectionDependencyError);
  });

  it('uses the default SQL candidate loader when no custom loader is provided', async () => {
    const sql = new SequenceSqlClient([
      {
        rows: [{
          request_attempt_archive_id: 'archive_1',
          request_id: 'req_1',
          attempt_no: 1,
          org_id: 'org_1',
          api_key_id: 'api_1',
          provider: 'openai',
          model: 'gpt-5.2',
          status: 'success',
          started_at: '2026-03-31T10:00:00.000Z',
          completed_at: '2026-03-31T10:01:00.000Z',
          route_decision: { request_source: 'openclaw' },
          input_tokens: 12,
          output_tokens: 8
        }],
        rowCount: 1
      },
      {
        rows: [
          {
            side: 'request',
            normalized_payload: message('user', [{ type: 'text', text: 'fix this migration' }])
          },
          {
            side: 'response',
            normalized_payload: message('assistant', [{ type: 'text', text: 'here is the fix' }])
          }
        ],
        rowCount: 2
      },
      {
        rows: [],
        rowCount: 0
      }
    ]);
    const requestRows: AdminAnalysisRequestRow[] = [];
    const service = new AdminAnalysisProjectorService({
      sql,
      requestRepo: {
        async upsertRequest(input) {
          const row: AdminAnalysisRequestRow = {
            request_attempt_archive_id: input.requestAttemptArchiveId,
            request_id: input.requestId,
            attempt_no: input.attemptNo,
            session_key: input.sessionKey,
            org_id: input.orgId,
            api_key_id: input.apiKeyId,
            session_type: input.sessionType,
            grouping_basis: input.groupingBasis,
            source: input.source,
            provider: input.provider,
            model: input.model,
            status: input.status,
            started_at: input.startedAt.toISOString(),
            completed_at: input.completedAt ? input.completedAt.toISOString() : null,
            input_tokens: input.inputTokens,
            output_tokens: input.outputTokens,
            user_message_preview: input.userMessagePreview,
            assistant_text_preview: input.assistantTextPreview,
            task_category: input.taskCategory,
            task_tags: [...input.taskTags],
            is_retry: input.isRetry,
            is_failure: input.isFailure,
            is_partial: input.isPartial,
            is_high_token: input.isHighToken,
            is_cross_provider_rescue: input.isCrossProviderRescue,
            has_tool_use: input.hasToolUse,
            interestingness_score: input.interestingnessScore,
            created_at: new Date('2026-03-31T00:00:00.000Z').toISOString(),
            updated_at: new Date('2026-03-31T00:00:00.000Z').toISOString()
          };
          requestRows.push(row);
          return row;
        },
        async listBySessionKey() {
          return requestRows;
        }
      },
      sessionAnalysisRepo: {
        async upsertSession(input) {
          return {
            session_key: input.sessionKey,
            org_id: input.orgId,
            session_type: input.sessionType,
            grouping_basis: input.groupingBasis,
            started_at: input.startedAt.toISOString(),
            ended_at: input.endedAt.toISOString(),
            last_activity_at: input.lastActivityAt.toISOString(),
            request_count: input.requestCount,
            attempt_count: input.attemptCount,
            input_tokens: input.inputTokens,
            output_tokens: input.outputTokens,
            primary_task_category: input.primaryTaskCategory,
            task_category_breakdown: input.taskCategoryBreakdown,
            task_tag_set: input.taskTagSet,
            is_long_session: input.isLongSession,
            is_high_token_session: input.isHighTokenSession,
            is_retry_heavy_session: input.isRetryHeavySession,
            is_cross_provider_session: input.isCrossProviderSession,
            is_multi_model_session: input.isMultiModelSession,
            interestingness_score: input.interestingnessScore,
            created_at: new Date('2026-03-31T00:00:00.000Z').toISOString(),
            updated_at: new Date('2026-03-31T00:00:00.000Z').toISOString()
          };
        }
      },
      sessionAttemptRepo: {
        async findByArchiveId() {
          return sessionLink({
            session_key: 'openclaw:run:run_1',
            request_attempt_archive_id: 'archive_1'
          });
        }
      },
      adminSessionRepo: {
        async findBySessionKey() {
          return adminSession({
            session_key: 'openclaw:run:run_1',
            session_type: 'openclaw',
            grouping_basis: 'explicit_run_id',
            source_session_id: null,
            source_run_id: 'run_1'
          });
        }
      }
    });

    const result = await service.projectQueuedAttempt({
      request_attempt_archive_id: 'archive_1'
    });

    expect(result).toEqual({
      outcome: 'projected',
      sessionKey: 'openclaw:run:run_1',
      requestAttemptArchiveId: 'archive_1'
    });
    expect(requestRows[0]?.user_message_preview).toContain('fix this migration');
  });

  it('projects one archived attempt into request analysis and session rollups', async () => {
    const harness = createHarness();
    harness.candidates.set('archive_1', candidate({
      requestMessages: [
        message('system', [{ type: 'text', text: 'repo policy' }]),
        message('user', [{ type: 'text', text: 'debug the postgres migration failure' }])
      ]
    }));
    harness.sessionLinks.push(sessionLink());
    harness.adminSessions.push(adminSession());

    await harness.service.projectQueuedAttempt({
      request_attempt_archive_id: 'archive_1'
    });

    expect(harness.requestRows).toHaveLength(1);
    expect(harness.requestRows[0]).toEqual(expect.objectContaining({
      request_attempt_archive_id: 'archive_1',
      session_key: 'openclaw:session:sess_1',
      user_message_preview: 'debug the postgres migration failure',
      task_category: 'debugging'
    }));
    expect(harness.requestRows[0]?.task_tags).toEqual(expect.arrayContaining(['postgres', 'migration']));

    expect(harness.sessionRows).toHaveLength(1);
    expect(harness.sessionRows[0]).toEqual(expect.objectContaining({
      session_key: 'openclaw:session:sess_1',
      primary_task_category: 'debugging',
      request_count: 1,
      attempt_count: 1
    }));
  });

  it('keeps request projection idempotent and recomputes mixed-category session rollups deterministically', async () => {
    const harness = createHarness();
    harness.adminSessions.push(adminSession());
    harness.sessionLinks.push(sessionLink({
      request_attempt_archive_id: 'archive_1',
      request_id: 'req_1',
      provider: 'anthropic',
      model: 'claude-opus-4-1'
    }));
    harness.sessionLinks.push(sessionLink({
      request_attempt_archive_id: 'archive_2',
      request_id: 'req_2',
      attempt_no: 1,
      provider: 'openai',
      model: 'gpt-5.4'
    }));
    harness.sessionLinks.push(sessionLink({
      request_attempt_archive_id: 'archive_3',
      request_id: 'req_2',
      attempt_no: 2,
      provider: 'openai',
      model: 'gpt-5.4'
    }));
    harness.candidates.set('archive_1', candidate({
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_1',
      provider: 'anthropic',
      model: 'claude-opus-4-1',
      startedAt: new Date('2026-03-31T22:00:00Z'),
      completedAt: new Date('2026-03-31T22:10:00Z'),
      requestMessages: [
        message('user', [{ type: 'text', text: 'build the new analysis endpoint in typescript' }])
      ]
    }));
    harness.candidates.set('archive_2', candidate({
      requestAttemptArchiveId: 'archive_2',
      requestId: 'req_2',
      provider: 'openai',
      model: 'gpt-5.4',
      startedAt: new Date('2026-03-31T22:12:00Z'),
      completedAt: new Date('2026-03-31T22:20:00Z'),
      requestMessages: [
        message('user', [{ type: 'text', text: 'debug the postgres migration failure' }])
      ]
    }));
    harness.candidates.set('archive_3', candidate({
      requestAttemptArchiveId: 'archive_3',
      requestId: 'req_2',
      attemptNo: 2,
      provider: 'openai',
      model: 'gpt-5.4',
      startedAt: new Date('2026-03-31T22:21:00Z'),
      completedAt: new Date('2026-03-31T22:45:00Z'),
      inputTokens: 45_000,
      outputTokens: 3_000,
      providerFallbackFrom: 'anthropic',
      requestMessages: [
        message('user', [{ type: 'text', text: 'debug the postgres migration failure' }])
      ],
      responseMessages: [
        message('assistant', [{ type: 'tool_call', id: 'tool_1', name: 'logs', arguments: {} }])
      ]
    }));

    await harness.service.projectQueuedAttempt({ request_attempt_archive_id: 'archive_1' });
    await harness.service.projectQueuedAttempt({ request_attempt_archive_id: 'archive_1' });
    await harness.service.projectQueuedAttempt({ request_attempt_archive_id: 'archive_2' });
    await harness.service.projectQueuedAttempt({ request_attempt_archive_id: 'archive_3' });

    expect(harness.requestRows).toHaveLength(3);
    expect(harness.sessionRows).toHaveLength(1);
    expect(harness.sessionRows[0]).toEqual(expect.objectContaining({
      primary_task_category: 'debugging',
      request_count: 2,
      attempt_count: 3,
      is_long_session: true,
      is_high_token_session: true,
      is_retry_heavy_session: true,
      is_cross_provider_session: true,
      is_multi_model_session: true
    }));
    expect(harness.sessionRows[0]?.task_category_breakdown).toEqual({
      feature_building: 1,
      debugging: 2
    });
    expect(harness.sessionRows[0]?.task_tag_set).toEqual(expect.arrayContaining(['typescript', 'postgres', 'migration']));
  });
});
