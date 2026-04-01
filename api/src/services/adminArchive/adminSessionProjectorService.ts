import type { AdminSessionAttemptRepository } from '../../repos/adminSessionAttemptRepository.js';
import type { AdminSessionProjectionOutboxRow } from '../../repos/adminSessionProjectionOutboxRepository.js';
import type { AdminSessionRepository, AdminSessionRow } from '../../repos/adminSessionRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import type {
  AdminSessionPreviewSample,
  AdminSessionProjectionCandidate,
  AdminSessionProjectionResult
} from './adminArchiveTypes.js';
import { projectionEventTime, resolveAdminSessionGrouping, DEFAULT_ADMIN_SESSION_IDLE_GAP_MS } from './sessionGrouping.js';

type CandidateLoader = {
  loadCandidateByArchiveId(requestAttemptArchiveId: string): Promise<AdminSessionProjectionCandidate | null>;
};

type ProjectionCandidateRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  started_at: string;
  completed_at: string | null;
  request_source: string | null;
  provider_selection_reason: string | null;
  openclaw_run_id: string | null;
  openclaw_session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  prompt_preview: string | null;
  response_preview: string | null;
};

export class AdminSessionProjectorService {
  private readonly idleGapMs: number;
  private readonly candidateLoader: CandidateLoader;

  constructor(private readonly deps: {
    sessionRepo: Pick<AdminSessionRepository, 'findBySessionKey' | 'findLatestInLane' | 'upsertSession'>;
    sessionAttemptRepo: Pick<AdminSessionAttemptRepository, 'listAttemptsBySessionKey' | 'upsertAttemptLink'>;
    sql?: Pick<SqlClient, 'query'>;
    candidateLoader?: CandidateLoader;
    idleGapMs?: number;
  }) {
    this.idleGapMs = deps.idleGapMs ?? DEFAULT_ADMIN_SESSION_IDLE_GAP_MS;
    this.candidateLoader = deps.candidateLoader ?? createSqlCandidateLoader(deps.sql);
  }

  async projectQueuedAttempt(
    outboxRow: Pick<AdminSessionProjectionOutboxRow, 'request_attempt_archive_id'>
  ): Promise<AdminSessionProjectionResult> {
    const candidate = await this.candidateLoader.loadCandidateByArchiveId(outboxRow.request_attempt_archive_id);
    if (!candidate) {
      throw new Error(`admin session projection candidate not found: ${outboxRow.request_attempt_archive_id}`);
    }
    return this.projectAttempt(candidate);
  }

  async projectAttempt(candidate: AdminSessionProjectionCandidate): Promise<AdminSessionProjectionResult> {
    const latestInLane = await this.findLatestInLaneIfNeeded(candidate);
    const grouping = resolveAdminSessionGrouping({
      candidate,
      latestInLane,
      idleGapMs: this.idleGapMs
    });

    if (!grouping) {
      return {
        outcome: 'ignored',
        reason: 'unsupported_request_source'
      };
    }

    const existingSession = await this.deps.sessionRepo.findBySessionKey(grouping.sessionKey);
    const existingAttempts = await this.deps.sessionAttemptRepo.listAttemptsBySessionKey(grouping.sessionKey);
    const wasNewAttempt = existingAttempts.every((attempt) =>
      attempt.request_attempt_archive_id !== candidate.requestAttemptArchiveId
    );
    const wasNewRequest = existingAttempts.every((attempt) => attempt.request_id !== candidate.requestId);
    const eventTime = projectionEventTime(candidate);

    await this.deps.sessionRepo.upsertSession({
      sessionKey: grouping.sessionKey,
      sessionType: grouping.sessionType,
      groupingBasis: grouping.groupingBasis,
      orgId: candidate.orgId,
      apiKeyId: candidate.apiKeyId,
      sourceSessionId: grouping.sourceSessionId,
      sourceRunId: grouping.sourceRunId,
      startedAt: existingSession ? minDate(new Date(existingSession.started_at), candidate.startedAt) : candidate.startedAt,
      endedAt: existingSession ? maxDate(new Date(existingSession.ended_at), eventTime) : eventTime,
      lastActivityAt: existingSession ? maxDate(new Date(existingSession.last_activity_at), eventTime) : eventTime,
      requestCount: existingSession
        ? existingSession.request_count + (wasNewAttempt && wasNewRequest ? 1 : 0)
        : 1,
      attemptCount: existingSession
        ? existingSession.attempt_count + (wasNewAttempt ? 1 : 0)
        : 1,
      inputTokens: existingSession
        ? existingSession.input_tokens + (wasNewAttempt ? candidate.inputTokens : 0)
        : candidate.inputTokens,
      outputTokens: existingSession
        ? existingSession.output_tokens + (wasNewAttempt ? candidate.outputTokens : 0)
        : candidate.outputTokens,
      providerSet: existingSession
        ? appendUnique(existingSession.provider_set, candidate.provider, wasNewAttempt)
        : [candidate.provider],
      modelSet: existingSession
        ? appendUnique(existingSession.model_set, candidate.model, wasNewAttempt)
        : [candidate.model],
      statusSummary: incrementStatusSummary(existingSession?.status_summary, candidate.status, wasNewAttempt),
      previewSample: mergePreviewSample(existingSession?.preview_sample ?? null, candidate, wasNewAttempt)
    });

    await this.deps.sessionAttemptRepo.upsertAttemptLink({
      sessionKey: grouping.sessionKey,
      requestAttemptArchiveId: candidate.requestAttemptArchiveId,
      requestId: candidate.requestId,
      attemptNo: candidate.attemptNo,
      eventTime,
      sequenceNo: Math.max(0, candidate.attemptNo - 1),
      provider: candidate.provider,
      model: candidate.model,
      streaming: candidate.streaming,
      status: candidate.status
    });

    return {
      outcome: 'projected',
      sessionKey: grouping.sessionKey,
      sessionType: grouping.sessionType,
      groupingBasis: grouping.groupingBasis,
      wasNewAttempt
    };
  }

  private async findLatestInLaneIfNeeded(candidate: AdminSessionProjectionCandidate): Promise<AdminSessionRow | null> {
    const grouping = resolveAdminSessionGrouping({
      candidate,
      latestInLane: null,
      idleGapMs: this.idleGapMs
    });
    if (!grouping || grouping.sessionType !== 'cli' || grouping.groupingBasis !== 'idle_gap') {
      return null;
    }

    return this.deps.sessionRepo.findLatestInLane({
      orgId: candidate.orgId,
      apiKeyId: candidate.apiKeyId,
      sessionType: 'cli'
    });
  }
}

function createSqlCandidateLoader(sql: Pick<SqlClient, 'query'> | undefined): CandidateLoader {
  if (!sql) {
    return {
      async loadCandidateByArchiveId() {
        throw new Error('admin session projector candidate loader is not configured');
      }
    };
  }

  return {
    async loadCandidateByArchiveId(requestAttemptArchiveId: string) {
      const query = `
        select
          a.id as request_attempt_archive_id,
          a.request_id,
          a.attempt_no,
          a.org_id,
          a.api_key_id,
          a.provider,
          a.model,
          a.streaming,
          a.status,
          a.started_at,
          a.completed_at,
          nullif(re.route_decision->>'request_source', '') as request_source,
          nullif(re.route_decision->>'provider_selection_reason', '') as provider_selection_reason,
          coalesce(nullif(re.route_decision->>'openclaw_run_id', ''), a.openclaw_run_id) as openclaw_run_id,
          coalesce(nullif(re.route_decision->>'openclaw_session_id', ''), a.openclaw_session_id) as openclaw_session_id,
          coalesce(ul.input_tokens, 0) as input_tokens,
          coalesce(ul.output_tokens, 0) as output_tokens,
          rl.prompt_preview,
          rl.response_preview
        from ${TABLES.requestAttemptArchives} a
        left join ${TABLES.routingEvents} re
          on re.org_id = a.org_id
          and re.request_id = a.request_id
          and re.attempt_no = a.attempt_no
        left join ${TABLES.usageLedger} ul
          on ul.org_id = a.org_id
          and ul.request_id = a.request_id
          and ul.attempt_no = a.attempt_no
          and ul.entry_type = 'usage'
        left join ${TABLES.requestLog} rl
          on rl.org_id = a.org_id
          and rl.request_id = a.request_id
          and rl.attempt_no = a.attempt_no
        where a.id = $1
        limit 1
      `;
      const result = await sql.query<ProjectionCandidateRow>(query, [requestAttemptArchiveId]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        requestAttemptArchiveId: row.request_attempt_archive_id,
        requestId: row.request_id,
        attemptNo: row.attempt_no,
        orgId: row.org_id,
        apiKeyId: row.api_key_id,
        provider: row.provider,
        model: row.model,
        streaming: row.streaming,
        status: row.status,
        startedAt: new Date(row.started_at),
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
        requestSource: row.request_source,
        providerSelectionReason: row.provider_selection_reason,
        openclawRunId: row.openclaw_run_id,
        openclawSessionId: row.openclaw_session_id,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        promptPreview: row.prompt_preview,
        responsePreview: row.response_preview
      };
    }
  };
}

function appendUnique(values: string[], next: string, includeNext: boolean): string[] {
  if (!includeNext) {
    return [...values];
  }
  return Array.from(new Set([...values, next]));
}

function incrementStatusSummary(
  current: Record<string, unknown> | null | undefined,
  status: 'success' | 'failed' | 'partial',
  includeNext: boolean
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) {
      summary[key] = count;
    }
  }

  if (includeNext) {
    summary[status] = (summary[status] ?? 0) + 1;
  }

  return summary;
}

function mergePreviewSample(
  current: Record<string, unknown> | null,
  candidate: AdminSessionProjectionCandidate,
  includeNext: boolean
): AdminSessionPreviewSample | null {
  const existingPromptPreview = typeof current?.promptPreview === 'string' ? current.promptPreview : null;
  const existingResponsePreview = typeof current?.responsePreview === 'string' ? current.responsePreview : null;
  const promptPreview = includeNext ? (candidate.promptPreview ?? existingPromptPreview) : existingPromptPreview;
  const responsePreview = includeNext ? (candidate.responsePreview ?? existingResponsePreview) : existingResponsePreview;

  if (!promptPreview && !responsePreview && !current) {
    return null;
  }

  return {
    promptPreview,
    responsePreview,
    latestRequestId: includeNext
      ? candidate.requestId
      : (typeof current?.latestRequestId === 'string' ? current.latestRequestId : candidate.requestId),
    latestAttemptNo: includeNext
      ? candidate.attemptNo
      : (typeof current?.latestAttemptNo === 'number' ? current.latestAttemptNo : candidate.attemptNo)
  };
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function maxDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}
