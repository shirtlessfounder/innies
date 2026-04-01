import { describe, expect, it } from 'vitest';
import type { AdminSessionAttemptRow } from '../src/repos/adminSessionAttemptRepository.js';
import type { AdminSessionRow } from '../src/repos/adminSessionRepository.js';
import type {
  AdminSessionGroupingBasis,
  AdminSessionProjectionCandidate,
  AdminSessionType
} from '../src/services/adminArchive/adminArchiveTypes.js';
import { AdminSessionProjectorService } from '../src/services/adminArchive/adminSessionProjectorService.js';

type State = {
  sessions: AdminSessionRow[];
  attempts: AdminSessionAttemptRow[];
};

function createHarness(options?: {
  idleGapMs?: number;
}) {
  const state: State = {
    sessions: [],
    attempts: []
  };

  const service = new AdminSessionProjectorService({
    idleGapMs: options?.idleGapMs,
    sessionRepo: {
      async upsertSession(input) {
        const row: AdminSessionRow = {
          session_key: input.sessionKey,
          session_type: input.sessionType,
          grouping_basis: input.groupingBasis,
          org_id: input.orgId,
          api_key_id: input.apiKeyId,
          source_session_id: input.sourceSessionId,
          source_run_id: input.sourceRunId,
          started_at: input.startedAt.toISOString(),
          ended_at: input.endedAt.toISOString(),
          last_activity_at: input.lastActivityAt.toISOString(),
          request_count: input.requestCount,
          attempt_count: input.attemptCount,
          input_tokens: input.inputTokens,
          output_tokens: input.outputTokens,
          provider_set: [...input.providerSet],
          model_set: [...input.modelSet],
          status_summary: structuredClone(input.statusSummary),
          preview_sample: input.previewSample ? structuredClone(input.previewSample) : null,
          created_at: new Date('2026-03-31T00:00:00Z').toISOString(),
          updated_at: new Date('2026-03-31T00:00:00Z').toISOString()
        };
        const index = state.sessions.findIndex((candidate) => candidate.session_key === row.session_key);
        if (index >= 0) {
          state.sessions[index] = row;
        } else {
          state.sessions.push(row);
        }
        return row;
      },
      async findBySessionKey(sessionKey) {
        return state.sessions.find((candidate) => candidate.session_key === sessionKey) ?? null;
      },
      async findLatestInLane(input) {
        const matches = state.sessions
          .filter((candidate) =>
            candidate.org_id === input.orgId
            && candidate.api_key_id === input.apiKeyId
            && candidate.session_type === input.sessionType
          )
          .sort((left, right) =>
            new Date(right.last_activity_at).getTime() - new Date(left.last_activity_at).getTime()
            || right.session_key.localeCompare(left.session_key)
          );
        return matches[0] ?? null;
      }
    },
    sessionAttemptRepo: {
      async upsertAttemptLink(input) {
        const row: AdminSessionAttemptRow = {
          session_key: input.sessionKey,
          request_attempt_archive_id: input.requestAttemptArchiveId,
          request_id: input.requestId,
          attempt_no: input.attemptNo,
          event_time: input.eventTime.toISOString(),
          sequence_no: input.sequenceNo,
          provider: input.provider,
          model: input.model,
          streaming: input.streaming,
          status: input.status,
          created_at: new Date('2026-03-31T00:00:00Z').toISOString()
        };
        const index = state.attempts.findIndex((candidate) =>
          candidate.session_key === row.session_key
          && candidate.request_attempt_archive_id === row.request_attempt_archive_id
        );
        if (index >= 0) {
          state.attempts[index] = row;
        } else {
          state.attempts.push(row);
        }
        return row;
      },
      async listAttemptsBySessionKey(sessionKey) {
        return state.attempts
          .filter((candidate) => candidate.session_key === sessionKey)
          .sort((left, right) =>
            new Date(left.event_time).getTime() - new Date(right.event_time).getTime()
            || left.request_id.localeCompare(right.request_id)
            || left.attempt_no - right.attempt_no
            || left.sequence_no - right.sequence_no
          );
      }
    }
  });

  return { service, state };
}

function candidate(input?: Partial<AdminSessionProjectionCandidate>): AdminSessionProjectionCandidate {
  return {
    requestAttemptArchiveId: 'archive_1',
    requestId: 'req_1',
    attemptNo: 1,
    orgId: 'org_1',
    apiKeyId: 'api_1',
    provider: 'anthropic',
    model: 'claude-opus-4-1',
    streaming: false,
    status: 'success',
    startedAt: new Date('2026-03-31T22:00:00Z'),
    completedAt: new Date('2026-03-31T22:00:05Z'),
    requestSource: 'openclaw',
    providerSelectionReason: null,
    openclawRunId: 'run_1',
    openclawSessionId: 'session_1',
    inputTokens: 10,
    outputTokens: 20,
    promptPreview: 'hello',
    responsePreview: 'world',
    ...input
  };
}

function expectSingleSession(state: State, input: {
  sessionKey: string;
  sessionType: AdminSessionType;
  groupingBasis: AdminSessionGroupingBasis;
}): AdminSessionRow {
  expect(state.sessions).toHaveLength(1);
  expect(state.sessions[0]).toEqual(expect.objectContaining({
    session_key: input.sessionKey,
    session_type: input.sessionType,
    grouping_basis: input.groupingBasis
  }));
  return state.sessions[0]!;
}

describe('AdminSessionProjectorService', () => {
  it('groups openclaw attempts by explicit session id when present', async () => {
    const { service, state } = createHarness();

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_1',
      requestId: 'req_1',
      openclawSessionId: 'sess_a',
      openclawRunId: 'run_a'
    }));
    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_2',
      requestId: 'req_2',
      attemptNo: 2,
      startedAt: new Date('2026-03-31T22:01:00Z'),
      completedAt: new Date('2026-03-31T22:01:05Z'),
      openclawSessionId: 'sess_a',
      openclawRunId: 'run_b'
    }));

    const session = expectSingleSession(state, {
      sessionKey: 'openclaw:session:sess_a',
      sessionType: 'openclaw',
      groupingBasis: 'explicit_session_id'
    });
    expect(session.request_count).toBe(2);
    expect(session.attempt_count).toBe(2);
    expect(state.attempts).toHaveLength(2);
  });

  it('falls back to openclaw run id when no explicit session id is present', async () => {
    const { service, state } = createHarness();

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_run',
      openclawSessionId: null,
      openclawRunId: 'run_only'
    }));

    const session = expectSingleSession(state, {
      sessionKey: 'openclaw:run:run_only',
      sessionType: 'openclaw',
      groupingBasis: 'explicit_run_id'
    });
    expect(session.source_session_id).toBeNull();
    expect(session.source_run_id).toBe('run_only');
  });

  it('appends nearby cli attempts into one idle-gap session', async () => {
    const { service, state } = createHarness();

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_1',
      requestId: 'req_cli_1',
      requestSource: 'cli-claude',
      openclawSessionId: null,
      openclawRunId: null,
      startedAt: new Date('2026-03-31T22:00:00Z'),
      completedAt: new Date('2026-03-31T22:05:00Z')
    }));
    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_2',
      requestId: 'req_cli_2',
      attemptNo: 2,
      requestSource: 'cli-claude',
      openclawSessionId: null,
      openclawRunId: null,
      startedAt: new Date('2026-03-31T22:20:00Z'),
      completedAt: new Date('2026-03-31T22:21:00Z')
    }));

    const session = expectSingleSession(state, {
      sessionKey: 'cli:idle:org_1:api_1:req_cli_1',
      sessionType: 'cli',
      groupingBasis: 'idle_gap'
    });
    expect(session.request_count).toBe(2);
    expect(session.attempt_count).toBe(2);
  });

  it('starts a new cli idle-gap session after the idle threshold', async () => {
    const { service, state } = createHarness();

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_1',
      requestId: 'req_cli_1',
      requestSource: 'cli-codex',
      provider: 'openai',
      model: 'gpt-5.4',
      openclawSessionId: null,
      openclawRunId: null,
      startedAt: new Date('2026-03-31T22:00:00Z'),
      completedAt: new Date('2026-03-31T22:01:00Z')
    }));
    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_2',
      requestId: 'req_cli_2',
      attemptNo: 2,
      requestSource: 'cli-codex',
      provider: 'openai',
      model: 'gpt-5.4',
      openclawSessionId: null,
      openclawRunId: null,
      startedAt: new Date('2026-03-31T23:00:00Z'),
      completedAt: new Date('2026-03-31T23:01:00Z')
    }));

    expect(state.sessions.map((session) => session.session_key).sort()).toEqual([
      'cli:idle:org_1:api_1:req_cli_1',
      'cli:idle:org_1:api_1:req_cli_2'
    ]);
  });

  it('ignores direct requests in v1', async () => {
    const { service, state } = createHarness();

    const result = await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_direct',
      requestSource: 'direct',
      openclawSessionId: null,
      openclawRunId: null
    }));

    expect(result).toEqual({ outcome: 'ignored', reason: 'unsupported_request_source' });
    expect(state.sessions).toEqual([]);
    expect(state.attempts).toEqual([]);
  });

  it('upserts the parent session before linking the child attempt row', async () => {
    let sessionWritten = false;
    const calls: string[] = [];
    const service = new AdminSessionProjectorService({
      sessionRepo: {
        async upsertSession() {
          sessionWritten = true;
          calls.push('session');
          return {} as AdminSessionRow;
        },
        async findBySessionKey() {
          return null;
        },
        async findLatestInLane() {
          return null;
        }
      },
      sessionAttemptRepo: {
        async upsertAttemptLink() {
          calls.push('attempt');
          expect(sessionWritten).toBe(true);
          return {} as AdminSessionAttemptRow;
        },
        async listAttemptsBySessionKey() {
          return [];
        }
      }
    });

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_parent_first',
      requestId: 'req_parent_first',
      requestSource: 'cli-codex',
      provider: 'openai',
      model: 'gpt-5.4',
      openclawSessionId: null,
      openclawRunId: null
    }));

    expect(calls).toEqual(['session', 'attempt']);
  });

  it('recomputes counts, tokens, and preview sample after appending an attempt', async () => {
    const { service, state } = createHarness();

    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_1',
      requestId: 'req_cli_1',
      requestSource: 'cli-claude',
      openclawSessionId: null,
      openclawRunId: null,
      inputTokens: 10,
      outputTokens: 20,
      promptPreview: 'first prompt',
      responsePreview: 'first response'
    }));
    await service.projectAttempt(candidate({
      requestAttemptArchiveId: 'archive_cli_2',
      requestId: 'req_cli_2',
      attemptNo: 2,
      requestSource: 'cli-claude',
      openclawSessionId: null,
      openclawRunId: null,
      startedAt: new Date('2026-03-31T22:10:00Z'),
      completedAt: new Date('2026-03-31T22:10:10Z'),
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 5,
      outputTokens: 7,
      promptPreview: 'second prompt',
      responsePreview: 'second response'
    }));

    const session = expectSingleSession(state, {
      sessionKey: 'cli:idle:org_1:api_1:req_cli_1',
      sessionType: 'cli',
      groupingBasis: 'idle_gap'
    });
    expect(session.request_count).toBe(2);
    expect(session.attempt_count).toBe(2);
    expect(session.input_tokens).toBe(15);
    expect(session.output_tokens).toBe(27);
    expect(session.provider_set).toEqual(['anthropic', 'openai']);
    expect(session.model_set).toEqual(['claude-opus-4-1', 'gpt-5.4']);
    expect(session.status_summary).toEqual({ success: 2 });
    expect(session.preview_sample).toEqual({
      promptPreview: 'second prompt',
      responsePreview: 'second response',
      latestRequestId: 'req_cli_2',
      latestAttemptNo: 2
    });
  });
});
