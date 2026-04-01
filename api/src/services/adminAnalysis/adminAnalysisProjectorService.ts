import type { AdminAnalysisRequestRepository, AdminAnalysisRequestRow } from '../../repos/adminAnalysisRequestRepository.js';
import type { AdminAnalysisSessionRepository } from '../../repos/adminAnalysisSessionRepository.js';
import type { AdminSessionAttemptRepository, AdminSessionAttemptRow } from '../../repos/adminSessionAttemptRepository.js';
import type { AdminSessionRepository, AdminSessionRow } from '../../repos/adminSessionRepository.js';
import type { SqlClient } from '../../repos/sqlClient.js';
import { TABLES } from '../../repos/tableNames.js';
import type { NormalizedArchiveMessage } from '../archive/archiveTypes.js';
import { decodeArchiveRawBlob } from '../archive/archiveCodec.js';
import { classifyAnalyticsSource } from '../../utils/analytics.js';
import type { AdminAnalysisProjectionCandidate, AdminAnalysisTaskCategory } from './adminAnalysisTypes.js';
import {
  classifyTaskCategory,
  deriveAssistantTextPreview,
  deriveInterestingnessScore,
  deriveRequestSignals,
  deriveTaskTags,
  deriveUserMessagePreview
} from './adminAnalysisDerivation.js';

type CandidateLoader = {
  loadCandidateByArchiveId(requestAttemptArchiveId: string): Promise<AdminAnalysisProjectionCandidate | null>;
};

export class RetryableProjectionDependencyError extends Error {}

export class AdminAnalysisProjectorService {
  constructor(private readonly deps: {
    candidateLoader?: CandidateLoader;
    sql?: Pick<SqlClient, 'query'>;
    requestRepo: Pick<AdminAnalysisRequestRepository, 'upsertRequest' | 'listBySessionKey'>;
    sessionAnalysisRepo: Pick<AdminAnalysisSessionRepository, 'upsertSession'>;
    sessionAttemptRepo: Pick<AdminSessionAttemptRepository, 'findByArchiveId'>;
    adminSessionRepo: Pick<AdminSessionRepository, 'findBySessionKey'>;
  }) {
    this.candidateLoader = deps.candidateLoader ?? createSqlCandidateLoader(deps.sql);
  }

  private readonly candidateLoader: CandidateLoader;

  async projectQueuedAttempt(outboxRow: Pick<AdminSessionAttemptRow, 'request_attempt_archive_id'>): Promise<{
    sessionKey: string;
    requestAttemptArchiveId: string;
  }> {
    const candidate = await this.candidateLoader.loadCandidateByArchiveId(outboxRow.request_attempt_archive_id);
    if (!candidate) {
      throw new Error(`admin analysis projection candidate not found: ${outboxRow.request_attempt_archive_id}`);
    }

    const sessionAttempt = await this.deps.sessionAttemptRepo.findByArchiveId(candidate.requestAttemptArchiveId);
    if (!sessionAttempt) {
      throw new RetryableProjectionDependencyError(
        `admin analysis projection waiting for admin session projection: ${candidate.requestAttemptArchiveId}`
      );
    }

    const session = await this.deps.adminSessionRepo.findBySessionKey(sessionAttempt.session_key);
    if (!session) {
      throw new RetryableProjectionDependencyError(
        `admin analysis projection waiting for admin session row: ${sessionAttempt.session_key}`
      );
    }

    const requestRow = await this.projectRequest(candidate, sessionAttempt, session);
    const sessionRows = await this.deps.requestRepo.listBySessionKey(session.session_key);
    await this.deps.sessionAnalysisRepo.upsertSession(buildSessionRollup(session, sessionRows));

    return {
      sessionKey: session.session_key,
      requestAttemptArchiveId: requestRow.request_attempt_archive_id
    };
  }

  private projectRequest(
    candidate: AdminAnalysisProjectionCandidate,
    sessionAttempt: Pick<AdminSessionAttemptRow, 'session_key'>,
    session: Pick<AdminSessionRow, 'session_type' | 'grouping_basis'>
  ) {
    const userMessagePreview = deriveUserMessagePreview(candidate.requestMessages);
    const assistantTextPreview = deriveAssistantTextPreview({
      responseMessages: candidate.responseMessages,
      rawResponse: candidate.rawResponse
    });
    const taskCategory = classifyTaskCategory({
      userMessagePreview,
      assistantTextPreview
    });
    const taskTags = deriveTaskTags({
      userMessagePreview,
      assistantTextPreview
    });
    const signals = deriveRequestSignals({
      attemptNo: candidate.attemptNo,
      status: candidate.status,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      requestMessages: candidate.requestMessages,
      responseMessages: candidate.responseMessages,
      providerFallbackFrom: candidate.providerFallbackFrom ?? null
    });

    return this.deps.requestRepo.upsertRequest({
      requestAttemptArchiveId: candidate.requestAttemptArchiveId,
      requestId: candidate.requestId,
      attemptNo: candidate.attemptNo,
      sessionKey: sessionAttempt.session_key,
      orgId: candidate.orgId,
      apiKeyId: candidate.apiKeyId,
      sessionType: session.session_type,
      groupingBasis: session.grouping_basis,
      source: candidate.source,
      provider: candidate.provider,
      model: candidate.model,
      status: candidate.status,
      startedAt: candidate.startedAt,
      completedAt: candidate.completedAt,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      userMessagePreview,
      assistantTextPreview,
      taskCategory,
      taskTags,
      ...signals,
      interestingnessScore: deriveInterestingnessScore(signals)
    });
  }
}

type ProjectionCandidateRow = {
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  org_id: string;
  api_key_id: string | null;
  provider: string;
  model: string;
  status: 'success' | 'failed' | 'partial';
  started_at: string;
  completed_at: string | null;
  route_decision: Record<string, unknown> | null;
  input_tokens: number;
  output_tokens: number;
};

type ProjectionMessageRow = {
  side: 'request' | 'response';
  normalized_payload: NormalizedArchiveMessage;
};

type RawResponseRow = {
  blob_role: 'response' | 'stream';
  encoding: 'gzip' | 'none';
  payload: Buffer;
};

function buildSessionRollup(
  session: Pick<AdminSessionRow, 'session_key' | 'org_id' | 'session_type' | 'grouping_basis'>,
  requests: AdminAnalysisRequestRow[]
) {
  const requestIds = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  const tags = new Set<string>();
  const categoryBreakdown = new Map<AdminAnalysisTaskCategory, number>();
  let startedAt = new Date(requests[0]?.started_at ?? new Date().toISOString());
  let endedAt = eventTime(requests[0]);
  let lastActivityAt = endedAt;
  let inputTokens = 0;
  let outputTokens = 0;
  let retryCount = 0;
  let interestingnessScore = 0;

  for (const request of requests) {
    requestIds.add(request.request_id);
    providers.add(request.provider);
    models.add(request.model);
    request.task_tags.forEach((tag) => tags.add(tag));
    categoryBreakdown.set(request.task_category, (categoryBreakdown.get(request.task_category) ?? 0) + 1);
    inputTokens += Number(request.input_tokens ?? 0);
    outputTokens += Number(request.output_tokens ?? 0);
    interestingnessScore += Number(request.interestingness_score ?? 0);
    if (request.is_retry) retryCount += 1;

    const requestStart = new Date(request.started_at);
    const requestEnd = eventTime(request);
    if (requestStart < startedAt) startedAt = requestStart;
    if (requestEnd > endedAt) endedAt = requestEnd;
    if (requestEnd > lastActivityAt) lastActivityAt = requestEnd;
  }

  const primaryTaskCategory = selectPrimaryCategory(categoryBreakdown);
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

  return {
    sessionKey: session.session_key,
    orgId: session.org_id,
    sessionType: session.session_type,
    groupingBasis: session.grouping_basis,
    startedAt,
    endedAt,
    lastActivityAt,
    requestCount: requestIds.size,
    attemptCount: requests.length,
    inputTokens,
    outputTokens,
    primaryTaskCategory,
    taskCategoryBreakdown: Object.fromEntries(categoryBreakdown),
    taskTagSet: Array.from(tags),
    isLongSession: durationMs >= 30 * 60 * 1000,
    isHighTokenSession: inputTokens + outputTokens >= 40_000,
    isRetryHeavySession: retryCount > 0,
    isCrossProviderSession: providers.size > 1,
    isMultiModelSession: models.size > 1,
    interestingnessScore
  };
}

function selectPrimaryCategory(categoryBreakdown: Map<AdminAnalysisTaskCategory, number>): AdminAnalysisTaskCategory {
  let winner: AdminAnalysisTaskCategory = 'other';
  let maxCount = -1;
  for (const [category, count] of categoryBreakdown.entries()) {
    if (count > maxCount) {
      winner = category;
      maxCount = count;
    }
  }
  return winner;
}

function eventTime(request: Pick<AdminAnalysisRequestRow, 'completed_at' | 'started_at'>): Date {
  return new Date(request.completed_at ?? request.started_at);
}

function createSqlCandidateLoader(sql: Pick<SqlClient, 'query'> | undefined): CandidateLoader {
  if (!sql) {
    return {
      async loadCandidateByArchiveId() {
        throw new Error('admin analysis projector candidate loader is not configured');
      }
    };
  }

  return {
    async loadCandidateByArchiveId(requestAttemptArchiveId: string) {
      const candidateQuery = `
        select
          a.id as request_attempt_archive_id,
          a.request_id,
          a.attempt_no,
          a.org_id,
          a.api_key_id,
          a.provider,
          a.model,
          a.status,
          a.started_at,
          a.completed_at,
          re.route_decision,
          coalesce(ul.input_tokens, 0) as input_tokens,
          coalesce(ul.output_tokens, 0) as output_tokens
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
        where a.id = $1
        limit 1
      `;
      const candidateResult = await sql.query<ProjectionCandidateRow>(candidateQuery, [requestAttemptArchiveId]);
      const row = candidateResult.rows[0];
      if (!row) {
        return null;
      }

      const messagesQuery = `
        select
          ram.side,
          mb.normalized_payload
        from ${TABLES.requestAttemptMessages} ram
        inner join ${TABLES.messageBlobs} mb
          on mb.id = ram.message_blob_id
        where ram.request_attempt_archive_id = $1
        order by
          case ram.side when 'request' then 0 when 'response' then 1 else 2 end asc,
          ram.ordinal asc
      `;
      const messageResult = await sql.query<ProjectionMessageRow>(messagesQuery, [requestAttemptArchiveId]);
      const requestMessages: NormalizedArchiveMessage[] = [];
      const responseMessages: NormalizedArchiveMessage[] = [];
      for (const message of messageResult.rows) {
        const normalized = message.normalized_payload;
        if (message.side === 'request') {
          requestMessages.push(normalized);
        } else {
          responseMessages.push(normalized);
        }
      }

      const rawQuery = `
        select
          rab.blob_role,
          rb.encoding,
          rb.payload
        from ${TABLES.requestAttemptRawBlobs} rab
        inner join ${TABLES.rawBlobs} rb
          on rb.id = rab.raw_blob_id
        where rab.request_attempt_archive_id = $1
          and rab.blob_role in ('response', 'stream')
        order by case rab.blob_role when 'response' then 0 else 1 end asc
      `;
      const rawResult = await sql.query<RawResponseRow>(rawQuery, [requestAttemptArchiveId]);
      const rawResponse = rawResult.rows[0]
        ? decodeArchiveRawBlob({
          encoding: rawResult.rows[0].encoding,
          payload: rawResult.rows[0].payload
        }).toString('utf8')
        : null;

      return {
        requestAttemptArchiveId: row.request_attempt_archive_id,
        requestId: row.request_id,
        attemptNo: row.attempt_no,
        orgId: row.org_id,
        apiKeyId: row.api_key_id,
        source: classifyAnalyticsSource({
          provider: row.provider,
          routeDecision: row.route_decision
        }),
        provider: row.provider,
        model: row.model,
        status: row.status,
        startedAt: new Date(row.started_at),
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        providerFallbackFrom: readString(row.route_decision?.provider_fallback_from),
        requestMessages,
        responseMessages,
        rawResponse
      } satisfies AdminAnalysisProjectionCandidate;
    }
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
